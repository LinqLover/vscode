/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from 'vs/base/common/color';
import { Emitter } from 'vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference, MutableDisposable } from 'vs/base/common/lifecycle';
import { Range } from 'vs/editor/common/core/range';
import { BracketPair, BracketPairColorizationOptions, BracketPairWithMinIndentation, IModelDecoration, ITextModel } from 'vs/editor/common/model';
import { DenseKeyProvider } from 'vs/editor/common/model/bracketPairColorizer/smallImmutableSet';
import { DecorationProvider } from 'vs/editor/common/model/decorationProvider';
import { BackgroundTokenizationState, TextModel } from 'vs/editor/common/model/textModel';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { ILanguageConfigurationService, ResolvedLanguageConfiguration } from 'vs/editor/common/modes/languageConfigurationRegistry';
import {
	editorBracketHighlightingForeground1, editorBracketHighlightingForeground2, editorBracketHighlightingForeground3, editorBracketHighlightingForeground4, editorBracketHighlightingForeground5, editorBracketHighlightingForeground6, editorBracketHighlightingUnexpectedBracketForeground
} from 'vs/editor/common/view/editorColorRegistry';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { AstNode, AstNodeKind } from './ast';
import { TextEditInfo } from './beforeEditPositionMapper';
import { LanguageAgnosticBracketTokens } from './brackets';
import { Length, lengthAdd, lengthGreaterThanEqual, lengthLessThanEqual, lengthOfString, lengthsToRange, lengthZero, positionToLength, toLength } from './length';
import { parseDocument } from './parser';
import { FastTokenizer, TextBufferTokenizer } from './tokenizer';

export interface IBracketPairs {
	/**
	 * Gets all bracket pairs that intersect the given position.
	 * The result is sorted by the start position.
	 */
	getBracketPairsInRange(range: Range): BracketPair[];

	/**
	 * Gets all bracket pairs that intersect the given position.
	 * The result is sorted by the start position.
	 */
	getBracketPairsInRangeWithMinIndentation(range: Range): BracketPairWithMinIndentation[];
}

export class BracketPairColorizer extends Disposable implements DecorationProvider, IBracketPairs {
	private readonly didChangeDecorationsEmitter = new Emitter<void>();
	private readonly cache = this._register(new MutableDisposable<IReference<BracketPairColorizerImpl>>());

	get isDocumentSupported() {
		const maxSupportedDocumentLength = /* max lines */ 50_000 * /* average column count */ 100;
		return this.textModel.getValueLength() <= maxSupportedDocumentLength;
	}

	private bracketsRequested = false;
	private options: BracketPairColorizationOptions;

	constructor(
		private readonly textModel: TextModel,
		private readonly languageConfigurationService: ILanguageConfigurationService
	) {
		super();

		this.options = textModel.getOptions().bracketPairColorizationOptions;

		this._register(textModel.onDidChangeOptions(e => {
			this.options = textModel.getOptions().bracketPairColorizationOptions;

			this.cache.clear();
			this.updateCache();
		}));

		this._register(textModel.onDidChangeLanguage(e => {
			this.cache.clear();
			this.updateCache();
		}));

		this._register(textModel.onDidChangeAttached(() => {
			this.updateCache();
		}));

		this._register(
			this.languageConfigurationService.onDidChange(e => {
				if (!e.languageId || this.cache.value?.object.didLanguageChange(e.languageId)) {
					this.cache.clear();
					this.updateCache();
				}
			})
		);
	}

	private updateCache() {
		if (this.bracketsRequested || (this.textModel.isAttachedToEditor() && this.isDocumentSupported && this.options.enabled)) {
			if (!this.cache.value) {
				const store = new DisposableStore();

				this.cache.value = createDisposableRef(
					store.add(
						new BracketPairColorizerImpl(this.textModel, (languageId) => {
							return this.languageConfigurationService.getLanguageConfiguration(languageId);
						})
					),
					store
				);
				store.add(this.cache.value.object.onDidChangeDecorations(e => this.didChangeDecorationsEmitter.fire(e)));
				this.didChangeDecorationsEmitter.fire();
			}
		} else {
			this.cache.clear();
			this.didChangeDecorationsEmitter.fire();
		}
	}

	handleContentChanged(change: IModelContentChangedEvent) {
		this.cache.value?.object.handleContentChanged(change);
	}

	getDecorationsInRange(range: Range, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		if (ownerId === undefined) {
			return [];
		}
		if (!this.options.enabled) {
			return [];
		}
		return this.cache.value?.object.getDecorationsInRange(range, ownerId, filterOutValidation) || [];
	}

	getAllDecorations(ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		if (ownerId === undefined) {
			return [];
		}
		if (!this.options.enabled) {
			return [];
		}
		return this.cache.value?.object.getAllDecorations(ownerId, filterOutValidation) || [];
	}

	onDidChangeDecorations(listener: () => void): IDisposable {
		return this.didChangeDecorationsEmitter.event(listener);
	}

	/**
	 * Returns all bracket pairs that intersect the given range.
	 * The result is sorted by the start position.
	*/
	getBracketPairsInRange(range: Range): BracketPair[] {
		this.bracketsRequested = true;
		this.updateCache();
		return this.cache.value?.object.getBracketPairsInRange(range, false) || [];
	}

	getBracketPairsInRangeWithMinIndentation(range: Range): BracketPairWithMinIndentation[] {
		this.bracketsRequested = true;
		this.updateCache();
		return this.cache.value?.object.getBracketPairsInRange(range, true) || [];
	}
}

function createDisposableRef<T>(object: T, disposable?: IDisposable): IReference<T> {
	return {
		object,
		dispose: () => disposable?.dispose(),
	};
}

class BracketPairColorizerImpl extends Disposable implements DecorationProvider {
	private readonly didChangeDecorationsEmitter = new Emitter<void>();
	private readonly colorProvider = new ColorProvider();

	/*
		There are two trees:
		* The initial tree that has no token information and is used for performant initial bracket colorization.
		* The tree that used token information to detect bracket pairs.

		To prevent flickering, we only switch from the initial tree to tree with token information
		when tokenization completes.
		Since the text can be edited while background tokenization is in progress, we need to update both trees.
	*/
	private initialAstWithoutTokens: AstNode | undefined;
	private astWithTokens: AstNode | undefined;

	private readonly denseKeyProvider = new DenseKeyProvider<string>();
	private readonly brackets = new LanguageAgnosticBracketTokens(this.denseKeyProvider, this.getLanguageConfiguration);

	public didLanguageChange(languageId: string): boolean {
		return this.brackets.didLanguageChange(languageId);
	}

	readonly onDidChangeDecorations = this.didChangeDecorationsEmitter.event;

	constructor(
		private readonly textModel: TextModel,
		private readonly getLanguageConfiguration: (languageId: string) => ResolvedLanguageConfiguration
	) {
		super();

		this._register(textModel.onBackgroundTokenizationStateChanged(() => {
			if (textModel.backgroundTokenizationState === BackgroundTokenizationState.Completed) {
				const wasUndefined = this.initialAstWithoutTokens === undefined;
				// Clear the initial tree as we can use the tree with token information now.
				this.initialAstWithoutTokens = undefined;
				if (!wasUndefined) {
					this.didChangeDecorationsEmitter.fire();
				}
			}
		}));

		this._register(textModel.onDidChangeTokens(({ ranges }) => {
			const edits = ranges.map(r =>
				new TextEditInfo(
					toLength(r.fromLineNumber - 1, 0),
					toLength(r.toLineNumber, 0),
					toLength(r.toLineNumber - r.fromLineNumber + 1, 0)
				)
			);
			this.astWithTokens = this.parseDocumentFromTextBuffer(edits, this.astWithTokens, false);
			if (!this.initialAstWithoutTokens) {
				this.didChangeDecorationsEmitter.fire();
			}
		}));

		if (textModel.backgroundTokenizationState === BackgroundTokenizationState.Uninitialized) {
			// There are no token information yet
			const brackets = this.brackets.getSingleLanguageBracketTokens(this.textModel.getLanguageId());
			const tokenizer = new FastTokenizer(this.textModel.getValue(), brackets);
			this.initialAstWithoutTokens = parseDocument(tokenizer, [], undefined, true);
			this.astWithTokens = this.initialAstWithoutTokens;
		} else if (textModel.backgroundTokenizationState === BackgroundTokenizationState.Completed) {
			// Skip the initial ast, as there is no flickering.
			// Directly create the tree with token information.
			this.initialAstWithoutTokens = undefined;
			this.astWithTokens = this.parseDocumentFromTextBuffer([], undefined, false);
		} else if (textModel.backgroundTokenizationState === BackgroundTokenizationState.InProgress) {
			this.initialAstWithoutTokens = this.parseDocumentFromTextBuffer([], undefined, true);
			this.astWithTokens = this.initialAstWithoutTokens;
		}
	}

	handleContentChanged(change: IModelContentChangedEvent) {
		const edits = change.changes.map(c => {
			const range = Range.lift(c.range);
			return new TextEditInfo(
				positionToLength(range.getStartPosition()),
				positionToLength(range.getEndPosition()),
				lengthOfString(c.text)
			);
		}).reverse();

		this.astWithTokens = this.parseDocumentFromTextBuffer(edits, this.astWithTokens, false);
		if (this.initialAstWithoutTokens) {
			this.initialAstWithoutTokens = this.parseDocumentFromTextBuffer(edits, this.initialAstWithoutTokens, false);
		}
	}

	/**
	 * @pure (only if isPure = true)
	*/
	private parseDocumentFromTextBuffer(edits: TextEditInfo[], previousAst: AstNode | undefined, immutable: boolean): AstNode {
		// Is much faster if `isPure = false`.
		const isPure = false;
		const previousAstClone = isPure ? previousAst?.deepClone() : previousAst;
		const tokenizer = new TextBufferTokenizer(this.textModel, this.brackets);
		const result = parseDocument(tokenizer, edits, previousAstClone, immutable);
		return result;
	}

	getBracketsInRange(range: Range): BracketInfo[] {
		const startOffset = toLength(range.startLineNumber - 1, range.startColumn - 1);
		const endOffset = toLength(range.endLineNumber - 1, range.endColumn - 1);
		const result = new Array<BracketInfo>();
		const node = this.initialAstWithoutTokens || this.astWithTokens!;
		collectBrackets(node, lengthZero, node.length, startOffset, endOffset, result);
		return result;
	}

	getDecorationsInRange(range: Range, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		const result = new Array<IModelDecoration>();
		const bracketsInRange = this.getBracketsInRange(range);
		for (const bracket of bracketsInRange) {
			result.push({
				id: `bracket${bracket.hash()}`,
				options: { description: 'BracketPairColorization', inlineClassName: this.colorProvider.getInlineClassName(bracket) },
				ownerId: 0,
				range: bracket.range
			});
		}
		return result;
	}
	getAllDecorations(ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		return this.getDecorationsInRange(new Range(1, 1, this.textModel.getLineCount(), 1), ownerId, filterOutValidation);
	}

	getBracketPairsInRange(range: Range, includeMinIndentation: boolean): BracketPairWithMinIndentation[] {
		const result = new Array<BracketPairWithMinIndentation>();

		const startLength = positionToLength(range.getStartPosition());
		const endLength = positionToLength(range.getEndPosition());

		const node = this.initialAstWithoutTokens || this.astWithTokens!;
		const context = new CollectBracketPairsContext(result, includeMinIndentation, this.textModel);
		collectBracketPairs(node, lengthZero, node.length, startLength, endLength, context);

		return result;
	}
}

function collectBrackets(node: AstNode, nodeOffsetStart: Length, nodeOffsetEnd: Length, startOffset: Length, endOffset: Length, result: BracketInfo[], level: number = 0): void {
	if (node.kind === AstNodeKind.Bracket) {
		const range = lengthsToRange(nodeOffsetStart, nodeOffsetEnd);
		result.push(new BracketInfo(range, level - 1, false));
	} else if (node.kind === AstNodeKind.UnexpectedClosingBracket) {
		const range = lengthsToRange(nodeOffsetStart, nodeOffsetEnd);
		result.push(new BracketInfo(range, level - 1, true));
	} else if (node.kind === AstNodeKind.List) {
		for (const child of node.children) {
			nodeOffsetEnd = lengthAdd(nodeOffsetStart, child.length);
			if (lengthLessThanEqual(nodeOffsetStart, endOffset) && lengthGreaterThanEqual(nodeOffsetEnd, startOffset)) {
				collectBrackets(child, nodeOffsetStart, nodeOffsetEnd, startOffset, endOffset, result, level);
			}
			nodeOffsetStart = nodeOffsetEnd;
		}
	} else if (node.kind === AstNodeKind.Pair) {
		// Don't use node.children here to improve performance
		level++;

		{
			const child = node.openingBracket;
			nodeOffsetEnd = lengthAdd(nodeOffsetStart, child.length);
			if (lengthLessThanEqual(nodeOffsetStart, endOffset) && lengthGreaterThanEqual(nodeOffsetEnd, startOffset)) {
				collectBrackets(child, nodeOffsetStart, nodeOffsetEnd, startOffset, endOffset, result, level);
			}
			nodeOffsetStart = nodeOffsetEnd;
		}

		if (node.child) {
			const child = node.child;
			nodeOffsetEnd = lengthAdd(nodeOffsetStart, child.length);
			if (lengthLessThanEqual(nodeOffsetStart, endOffset) && lengthGreaterThanEqual(nodeOffsetEnd, startOffset)) {
				collectBrackets(child, nodeOffsetStart, nodeOffsetEnd, startOffset, endOffset, result, level);
			}
			nodeOffsetStart = nodeOffsetEnd;
		}
		if (node.closingBracket) {
			const child = node.closingBracket;
			nodeOffsetEnd = lengthAdd(nodeOffsetStart, child.length);
			if (lengthLessThanEqual(nodeOffsetStart, endOffset) && lengthGreaterThanEqual(nodeOffsetEnd, startOffset)) {
				collectBrackets(child, nodeOffsetStart, nodeOffsetEnd, startOffset, endOffset, result, level);
			}
			nodeOffsetStart = nodeOffsetEnd;
		}
	}
}

class CollectBracketPairsContext {
	constructor(
		public readonly result: BracketPairWithMinIndentation[],
		public readonly includeMinIndentation: boolean,
		public readonly textModel: ITextModel,
	) {
	}
}

function collectBracketPairs(node: AstNode, nodeOffset: Length, nodeOffsetEnd: Length, startOffset: Length, endOffset: Length, context: CollectBracketPairsContext, level: number = 0) {
	if (node.kind === AstNodeKind.Pair) {
		const openingBracketEnd = lengthAdd(nodeOffset, node.openingBracket.length);
		let minIndentation = -1;
		if (context.includeMinIndentation) {
			minIndentation = node.computeMinIndentation(nodeOffset, context.textModel);
		}

		context.result.push(new BracketPairWithMinIndentation(
			lengthsToRange(nodeOffset, nodeOffsetEnd),
			lengthsToRange(nodeOffset, openingBracketEnd),
			node.closingBracket
				? lengthsToRange(lengthAdd(openingBracketEnd, node.child?.length || lengthZero), nodeOffsetEnd)
				: undefined,
			level,
			minIndentation
		));
		level++;
	}

	let curOffset = nodeOffset;
	for (const child of node.children) {
		const childOffset = curOffset;
		curOffset = lengthAdd(curOffset, child.length);

		if (lengthLessThanEqual(childOffset, endOffset) && lengthLessThanEqual(startOffset, curOffset)) {
			collectBracketPairs(child, childOffset, curOffset, startOffset, endOffset, context, level);
		}
	}
}

export class BracketInfo {
	constructor(
		public readonly range: Range,
		/** 0-based level */
		public readonly level: number,
		public readonly isInvalid: boolean,
	) { }

	hash(): string {
		return `${this.range.toString()}-${this.level}`;
	}
}

class ColorProvider {
	public readonly unexpectedClosingBracketClassName = 'unexpected-closing-bracket';

	getInlineClassName(bracket: BracketInfo): string {
		if (bracket.isInvalid) {
			return this.unexpectedClosingBracketClassName;
		}
		return this.getInlineClassNameOfLevel(bracket.level);
	}

	getInlineClassNameOfLevel(level: number): string {
		// To support a dynamic amount of colors up to 6 colors,
		// we use a number that is a lcm of all numbers from 1 to 6.
		return `bracket-highlighting-${level % 30}`;
	}
}

registerThemingParticipant((theme, collector) => {
	const colors = [
		editorBracketHighlightingForeground1,
		editorBracketHighlightingForeground2,
		editorBracketHighlightingForeground3,
		editorBracketHighlightingForeground4,
		editorBracketHighlightingForeground5,
		editorBracketHighlightingForeground6
	];
	const colorProvider = new ColorProvider();

	collector.addRule(`.monaco-editor .${colorProvider.unexpectedClosingBracketClassName} { color: ${theme.getColor(editorBracketHighlightingUnexpectedBracketForeground)}; }`);

	let colorValues = colors
		.map(c => theme.getColor(c))
		.filter((c): c is Color => !!c)
		.filter(c => !c.isTransparent());

	for (let level = 0; level < 30; level++) {
		const color = colorValues[level % colorValues.length];
		collector.addRule(`.monaco-editor .${colorProvider.getInlineClassNameOfLevel(level)} { color: ${color}; }`);
	}
});
