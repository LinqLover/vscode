/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { EditorAction, registerEditorAction, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { DocumentFormattingEditProviderRegistry } from 'vs/editor/common/modes';
import * as nls from 'vs/nls';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { VIEWLET_ID, IExtensionsViewPaneContainer } from 'vs/workbench/contrib/extensions/common/extensions';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IPaneCompositePartService } from 'vs/workbench/services/panecomposite/browser/panecomposite';
import { ViewContainerLocation } from 'vs/workbench/common/views';

async function showExtensionQuery(paneCompositeService: IPaneCompositePartService, query: string) {
	const viewlet = await paneCompositeService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar, true);
	if (viewlet) {
		(viewlet?.getViewPaneContainer() as IExtensionsViewPaneContainer).search(query);
	}
}

registerEditorAction(class FormatDocumentMultipleAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.formatDocument.none',
			label: nls.localize('formatDocument.label.multiple', "Format Document"),
			alias: 'Format Document',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentFormattingProvider.toNegated()),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KEY_F,
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_I },
				weight: KeybindingWeight.EditorContrib,
			}
		});
	}

	async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.hasModel()) {
			return;
		}

		const commandService = accessor.get(ICommandService);
		const paneCompositeService = accessor.get(IPaneCompositePartService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);

		const model = editor.getModel();
		const formatterCount = DocumentFormattingEditProviderRegistry.all(model).length;

		if (formatterCount > 1) {
			return commandService.executeCommand('editor.action.formatDocument.multiple');
		} else if (formatterCount === 1) {
			return commandService.executeCommand('editor.action.formatDocument');
		} else if (model.isTooLargeForSyncing()) {
			notificationService.warn(nls.localize('too.large', "This file cannot be formatted because it is too large"));
		} else {
			const langName = model.getLanguageId();
			const message = nls.localize('no.provider', "There is no formatter for '{0}' files installed.", langName);
			const res = await dialogService.show(
				Severity.Info,
				message,
				[nls.localize('cancel', "Cancel"), nls.localize('install.formatter', "Install Formatter...")]
			);
			if (res.choice === 1) {
				showExtensionQuery(paneCompositeService, `category:formatters ${langName}`);
			}
		}
	}
});
