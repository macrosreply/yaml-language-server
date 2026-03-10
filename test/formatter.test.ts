/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as sinon from 'sinon';
import { TextEdit } from 'vscode-languageserver-types';
import { LanguageHandlers } from '../src/languageserver/handlers/languageHandlers';
import { SettingsState, TextDocumentTestManager } from '../src/yamlSettings';
import { ServiceSetup } from './utils/serviceSetup';
import { setupLanguageService, setupTextDocument } from './utils/testHelper';

type LanguageHandlerWithConnection = {
  connection: {
    workspace: {
      getConfiguration: (item?: { section?: string }) => Promise<unknown>;
    };
  };
};

describe('Formatter Tests', () => {
  const sandbox = sinon.createSandbox();
  let languageHandler: LanguageHandlers;
  let yamlSettings: SettingsState;

  afterEach(() => {
    sandbox.restore();
  });

  before(() => {
    const languageSettingsSetup = new ServiceSetup().withFormat();
    const { languageHandler: langHandler, yamlSettings: settings } = setupLanguageService(languageSettingsSetup.languageSettings);
    languageHandler = langHandler;
    yamlSettings = settings;
  });

  // Tests for formatter
  describe('Formatter', function () {
    describe('Test that formatter works with custom tags', function () {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function parseSetup(content: string, options: any = {}): Promise<TextEdit[]> {
        const testTextDocument = setupTextDocument(content);
        yamlSettings.documents = new TextDocumentTestManager();
        (yamlSettings.documents as TextDocumentTestManager).set(testTextDocument);
        yamlSettings.yamlFormatterSettings = options;
        return languageHandler.formatterHandler({
          options,
          textDocument: testTextDocument,
        });
      }

      it('Formatting works without custom tags', async () => {
        const content = 'cwd: test';
        const edits = await parseSetup(content);
        console.dir({ edits });
        assert.notEqual(edits.length, 0);
        assert.equal(edits[0].newText, 'cwd: test\n');
      });

      it('Formatting can be disabled via language-overridable yaml.format.enable setting', async () => {
        const content = 'cwd: test\n    test: 2';
        const testTextDocument = setupTextDocument(content);
        yamlSettings.documents = new TextDocumentTestManager();
        (yamlSettings.documents as TextDocumentTestManager).set(testTextDocument);
        const connection = (languageHandler as unknown as LanguageHandlerWithConnection).connection;
        sandbox.stub(connection.workspace, 'getConfiguration').resolves({ 'yaml.format.enable': false });
        yamlSettings.hasConfigurationCapability = true;
        const edits = await languageHandler.formatterHandler({
          options: { tabSize: 2, insertSpaces: true },
          textDocument: testTextDocument,
        });
        assert.equal(edits.length, 0);
      });

      it('Formatting works with custom tags', async () => {
        const content = 'cwd:       !Test test';
        const edits = await parseSetup(content);
        assert.notEqual(edits.length, 0);
        assert.equal(edits[0].newText, 'cwd: !Test test\n');
      });

      it('Formatting wraps text', async () => {
        const content = `comments: >
                test test test test test test test test test test test test`;
        const edits = await parseSetup(content, {
          printWidth: 20,
          proseWrap: 'always',
        });
        assert.equal(edits[0].newText, 'comments: >\n  test test test\n  test test test\n  test test test\n  test test test\n');
      });

      it('Formatting handles trailing commas (enabled)', async () => {
        const content = `{
  key: 'value',
  food: 'raisins',
  airport: 'YYZ',
  lightened_bulb: 'illuminating',
}
`;
        const edits = await parseSetup(content, { singleQuote: true });
        assert.equal(edits[0].newText, content);
      });

      it('Formatting handles trailing commas (disabled)', async () => {
        const content = `{
  key: 'value',
  food: 'raisins',
  airport: 'YYZ',
  lightened_bulb: 'illuminating',
}
`;
        const edits = await parseSetup(content, {
          singleQuote: true,
          trailingComma: false,
        });
        assert.equal(
          edits[0].newText,
          `{
  key: 'value',
  food: 'raisins',
  airport: 'YYZ',
  lightened_bulb: 'illuminating'
}
`
        );
      });

      it('Formatting uses tabSize', async () => {
        const content = `map:
  k1: v1
  k2: v2
list:
  - item1
  - item2
`;

        const edits = await parseSetup(content, {
          tabSize: 5,
        });

        const expected = `map:
     k1: v1
     k2: v2
list:
     - item1
     - item2
`;
        assert.equal(edits[0].newText, expected);
      });

      it('Formatting uses tabWidth', async () => {
        const content = `map:
  k1: v1
  k2: v2
list:
  - item1
  - item2
`;

        const edits = await parseSetup(content, {
          tabWidth: 5,
        });

        const expected = `map:
     k1: v1
     k2: v2
list:
     - item1
     - item2
`;
        assert.equal(edits[0].newText, expected);
      });

      it('Formatting uses tabWidth over tabSize', async () => {
        const content = `map:
  k1: v1
  k2: v2
list:
  - item1
  - item2
`;

        const edits = await parseSetup(content, {
          tabSize: 3,
          tabWidth: 5,
        });

        const expected = `map:
     k1: v1
     k2: v2
list:
     - item1
     - item2
`;
        assert.equal(edits[0].newText, expected);
      });

      it('Formatting formats embedded JavaScript in block scalar expressions', async () => {
        const content = `- name: eb-error
  handler: |
    \${{
      $rootVars.error=$error.response?.data?.errorMessage??"error_unknown"
    }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `- name: eb-error
  handler: |
    \${{
      $rootVars.error = $error.response?.data?.errorMessage ?? 'error_unknown'
    }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting formats embedded JavaScript in inline expressions', async () => {
        const content = `handler: \${{$rootVars.error=$error.response?.data?.errorMessage??"error_unknown"}}\n`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `handler: \${{ $rootVars.error = $error.response?.data?.errorMessage ?? 'error_unknown' }}\n`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting does not add defensive leading semicolon for embedded arrow function expression', async () => {
        const content = `- path: ""
  redirect: |
    \${{
      from => {
        return { path: \`/inbox/\${from.params.inboxId}/tasks\` }
      }
    }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `- path: ''
  redirect: |
    \${{
      (from) => {
        return { path: \`/inbox/\${from.params.inboxId}/tasks\` }
      }
    }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting does not add defensive leading semicolon for embedded template literal', async () => {
        const content = `emit:
  - name: eb-router-push
    params:
      path: \${{ \`/search/\${EB.utils.uuid()}\` }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `emit:
  - name: eb-router-push
    params:
      path: \${{ \`/search/\${EB.utils.uuid()}\` }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting does not add defensive leading semicolon for embedded regex literal', async () => {
        const content = `rules:
  - required: true
  - max: 256
  - pattern: \${{ /^[a-zA-Z0-9_]+$/ }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `rules:
  - required: true
  - max: 256
  - pattern: \${{ /^[a-zA-Z0-9_]+$/ }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting removes all semicolons from multi-line embedded statements', async () => {
        const content = `on:
  emit:
    - name: eb-logged-out
      handler: |
        \${{
          $rootVars.isLoggedIn = false
          $rootVars.viewingAllOf = null;
          $rootVars.currentSearchTerm = null;
        }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `on:
  emit:
    - name: eb-logged-out
      handler: |
        \${{
          $rootVars.isLoggedIn = false
          $rootVars.viewingAllOf = null
          $rootVars.currentSearchTerm = null
        }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting handles complex multi-statement embedded blocks with control flow', async () => {
        const content = `on:
  emit:
    - name: evt-init-current-user-storage
      handler: |
        \${{
          if (a) return;
          $rootVars.isLoggedIn = true;

          $rootStore.currentUser.id = +EB.auth.userContextPolicies.eClient.id;
          $rootStore.currentUser.username = EB.auth.userContextPolicies.eClient.username;
          $rootStore.currentUser.firstName = EB.auth.userContextPolicies.eClient.firstName;
          $rootStore.currentUser.lastName = EB.auth.userContextPolicies.eClient.lastName;
          $rootStore.currentUser.divisions = EB.auth.userContextPolicies.eClient.additions?.divisions ?? [];
          $rootStore.currentUser.inboxesCanBeAccessed = EB.auth.userContextPolicies.eClient.additions?.inboxesCanBeAccessed ?? [];

          EB.emitter.emit('eb-signal-subscribe', { channel: ['tab-infos'] });
          EB.emitter.emit('evt-load-current-user-rights');
        }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `on:
  emit:
    - name: evt-init-current-user-storage
      handler: |
        \${{
          if (a) return
          $rootVars.isLoggedIn = true

          $rootStore.currentUser.id = +EB.auth.userContextPolicies.eClient.id
          $rootStore.currentUser.username = EB.auth.userContextPolicies.eClient.username
          $rootStore.currentUser.firstName = EB.auth.userContextPolicies.eClient.firstName
          $rootStore.currentUser.lastName = EB.auth.userContextPolicies.eClient.lastName
          $rootStore.currentUser.divisions = EB.auth.userContextPolicies.eClient.additions?.divisions ?? []
          $rootStore.currentUser.inboxesCanBeAccessed = EB.auth.userContextPolicies.eClient.additions?.inboxesCanBeAccessed ?? []

          EB.emitter.emit('eb-signal-subscribe', { channel: ['tab-infos'] })
          EB.emitter.emit('evt-load-current-user-rights')
        }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting handles large embedded blocks with comments and multiple blank lines', async () => {
        const content = `on:
  emit:
    - name: eb-logged-out
      handler: |
        \${{
          $rootVars.isLoggedIn = false;
          $rootVars.viewingAllOf = null;
          $rootVars.currentSearchTerm = null;

          $rootStore.currentUser.id = null;
          $rootStore.currentUser.username = null;
          $rootStore.currentUser.firstName = null;
          $rootStore.currentUser.lastName = null;
          $rootStore.currentUser.divisions = null;
          $rootStore.currentUser.inboxesCanBeAccessed = null;
          $rootStore.currentUser.rights = null;
          // reset user preferences
          $rootStore.currentUser.inboxViewConfigs.archive = null;
          $rootStore.currentUser.inboxViewConfigs.open = null;
          $rootStore.currentUser.inboxViewConfigs.reminder = null;
          $rootStore.currentUser.inboxViewConfigs.done = null;
          $rootStore.currentUser.inboxViewConfigs.set = null;
          $rootStore.currentUser.inboxViewConfigs.case = null;
          $rootStore.currentUser.inboxViewConfigs.searchDocument = null;
          $rootStore.currentUser.inboxViewConfigs.searchCase = null;
          $rootStore.currentUser.inboxViewConfigs.searchFile = null;

          $rootStore.currentUser.fileViewConfigs.open = null;
          $rootStore.currentUser.fileViewConfigs.reminder = null;
          $rootStore.currentUser.fileViewConfigs.done = null;
          $rootStore.currentUser.fileViewConfigs.all = null;
          $rootStore.currentUser.fileViewConfigs.hidden = null;


          EB.emitter.emit('eb-cache-invalid', { tags: ['*'] });
          EB.emitter.emit('eb-state-store-remove', { key: ['*', '!current-user', '!right-view', '!global-document-viewer'] });

          EB.storage.app().delete('local', '__eb_layout_sidebar_root-sidebar-menu_collapsed');
        }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `on:
  emit:
    - name: eb-logged-out
      handler: |
        \${{
          $rootVars.isLoggedIn = false
          $rootVars.viewingAllOf = null
          $rootVars.currentSearchTerm = null

          $rootStore.currentUser.id = null
          $rootStore.currentUser.username = null
          $rootStore.currentUser.firstName = null
          $rootStore.currentUser.lastName = null
          $rootStore.currentUser.divisions = null
          $rootStore.currentUser.inboxesCanBeAccessed = null
          $rootStore.currentUser.rights = null
          // reset user preferences
          $rootStore.currentUser.inboxViewConfigs.archive = null
          $rootStore.currentUser.inboxViewConfigs.open = null
          $rootStore.currentUser.inboxViewConfigs.reminder = null
          $rootStore.currentUser.inboxViewConfigs.done = null
          $rootStore.currentUser.inboxViewConfigs.set = null
          $rootStore.currentUser.inboxViewConfigs.case = null
          $rootStore.currentUser.inboxViewConfigs.searchDocument = null
          $rootStore.currentUser.inboxViewConfigs.searchCase = null
          $rootStore.currentUser.inboxViewConfigs.searchFile = null

          $rootStore.currentUser.fileViewConfigs.open = null
          $rootStore.currentUser.fileViewConfigs.reminder = null
          $rootStore.currentUser.fileViewConfigs.done = null
          $rootStore.currentUser.fileViewConfigs.all = null
          $rootStore.currentUser.fileViewConfigs.hidden = null

          EB.emitter.emit('eb-cache-invalid', { tags: ['*'] })
          EB.emitter.emit('eb-state-store-remove', { key: ['*', '!current-user', '!right-view', '!global-document-viewer'] })

          EB.storage.app().delete('local', '__eb_layout_sidebar_root-sidebar-menu_collapsed')
        }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting corrects indent of closing delimiter to match opening', async () => {
        const content = `handler: |
  \${{
    $rootVars.isLoggedIn = false;
    $rootVars.viewingAllOf = null;
    }}
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `handler: |
  \${{
    $rootVars.isLoggedIn = false
    $rootVars.viewingAllOf = null
  }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting removes trailing spaces after closing delimiter', async () => {
        const content = `handler: |
  \${{
    $rootVars.test = 1;
    }}   
`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const expected = `handler: |
  \${{
    $rootVars.test = 1
  }}
`;

        assert.equal(edits[0].newText, expected);
      });

      it('Formatting collapses multi-line formatted inline expressions to single line', async () => {
        const content = `rootMemo:
  itemIds: \${{ ($route.query.itemIds ?? '').split(',')    .map((x) => parseInt(x)).filter((x) => !isNaN(x)) }}\n`;

        const edits = await parseSetup(content, {
          tabSize: 2,
          singleQuote: true,
          trailingComma: false,
        });

        const output = edits[0].newText;

        // Verify extra spaces are removed
        assert.ok(!output.includes("split(',')    .map"), 'Should remove extra spaces');

        // Verify it stays on a single line (inline)
        const lines = output.split('\n');
        const itemIdLine = lines.find((line) => line.includes('itemIds:'));
        assert.ok(itemIdLine, 'Should have itemIds line');

        // Should contain formatted expression on same line
        assert.ok(itemIdLine.includes('${{ '), 'Should have opening delimiter');
        assert.ok(itemIdLine.includes(' }}'), 'Should have closing delimiter');

        // Verify method chain is properly formatted
        assert.ok(itemIdLine.includes('.split'), 'Should have split method');
        assert.ok(itemIdLine.includes('.map'), 'Should have map method');
        assert.ok(itemIdLine.includes('.filter'), 'Should have filter method');
      });
    });
  });
});
