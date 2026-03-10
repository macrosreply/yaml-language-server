/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Adam Voss. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Range, Position, TextEdit, FormattingOptions } from 'vscode-languageserver-types';
import { CustomFormatterOptions, LanguageSettings } from '../yamlLanguageService';
import { Options, format, resolveConfig } from 'prettier';
import * as yamlPlugin from 'prettier/plugins/yaml';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';
import { TextDocument } from 'vscode-languageserver-textdocument';

export class YAMLFormatter {
  private formatterEnabled = true;

  private static readonly INDENT_FALLBACK = 2;

  public configure(shouldFormat: LanguageSettings): void {
    if (shouldFormat) {
      this.formatterEnabled = shouldFormat.format;
    }
  }

  public async format(
    document: TextDocument,
    options: Partial<FormattingOptions> & CustomFormatterOptions = {}
  ): Promise<TextEdit[]> {
    if (!this.formatterEnabled) {
      return [];
    }

    try {
      const text = document.getText();

      // Resolve prettier config from .prettierrc, .prettierrc.json, etc.
      const filePath = document.uri.replace(/^file:\/\//, '');
      const resolvedConfig = await resolveConfig(filePath);

      const prettierOptions: Options = {
        parser: 'yaml',
        plugins: [yamlPlugin, estreePlugin],
        // Start with explicit options as fallback defaults
        // --- FormattingOptions ---
        tabWidth: (options.tabWidth as number) || options.tabSize,

        // --- CustomFormatterOptions ---
        singleQuote: options.singleQuote,
        bracketSpacing: options.bracketSpacing,
        // 'preserve' is the default for Options.proseWrap. See also server.ts
        proseWrap: 'always' === options.proseWrap ? 'always' : 'never' === options.proseWrap ? 'never' : 'preserve',
        printWidth: options.printWidth,
        trailingComma: options.trailingComma === false ? 'none' : 'all',

        // Then apply resolved config from prettier config files (takes precedence)
        ...(resolvedConfig || {}),
      };

      const formatted = await format(text, prettierOptions);
      const formattedWithInlineEmbeddedJs = await this.formatInlineEmbeddedJavaScriptExpressions(
        formatted,
        options,
        resolvedConfig
      );
      const formattedWithEmbeddedJs = await this.formatEmbeddedJavaScriptBlocks(
        formattedWithInlineEmbeddedJs,
        options,
        resolvedConfig
      );

      return [TextEdit.replace(Range.create(Position.create(0, 0), document.positionAt(text.length)), formattedWithEmbeddedJs)];
    } catch (error) {
      return [];
    }
  }

  private async formatInlineEmbeddedJavaScriptExpressions(
    text: string,
    options: Partial<FormattingOptions> & CustomFormatterOptions,
    resolvedConfig: Options | null
  ): Promise<string> {
    const lines = text.split(/\r?\n/);
    const expressionPattern = /\$\{\{([\s\S]*?)\}\}/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('${{')) {
        continue;
      }

      // Block scalar delimiters are handled by formatEmbeddedJavaScriptBlocks.
      if (line.trim() === '${{' || line.trim() === '}}') {
        continue;
      }

      let rebuilt = '';
      let lastIndex = 0;
      let changed = false;
      let match: RegExpExecArray | null;

      while ((match = expressionPattern.exec(line)) !== null) {
        const original = match[0];
        const inner = match[1];
        let replacement = original;

        const formattedInner = await this.formatEmbeddedJavaScript(inner, options, resolvedConfig, true);
        if (formattedInner) {
          replacement = `\${{ ${formattedInner.trim()} }}`;
        }

        if (replacement !== original) {
          changed = true;
        }

        rebuilt += line.slice(lastIndex, match.index) + replacement;
        lastIndex = match.index + original.length;
      }

      if (changed) {
        rebuilt += line.slice(lastIndex);
        lines[i] = rebuilt;
      }
    }

    return lines.join('\n');
  }

  private async formatEmbeddedJavaScriptBlocks(
    text: string,
    options: Partial<FormattingOptions> & CustomFormatterOptions,
    resolvedConfig: Options | null
  ): Promise<string> {
    const lines = text.split(/\r?\n/);
    const indentSize = ((options.tabWidth as number) || options.tabSize || YAMLFormatter.INDENT_FALLBACK) as number;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '${{') {
        continue;
      }

      const openIndent = this.getLineIndent(lines[i]);
      let closeIndex = -1;

      for (let j = i + 1; j < lines.length; j++) {
        // Accept closing `}}` that is indented >= opening indent (required for YAML literal block)
        // Must be indented at least as much as opening, or it won't be part of the block content
        if (lines[j].trim() === '}}' && this.getLineIndent(lines[j]) >= openIndent) {
          closeIndex = j;
          break;
        }
      }

      if (closeIndex === -1) {
        continue;
      }

      const inner = lines.slice(i + 1, closeIndex).join('\n');
      const formattedInner = await this.formatEmbeddedJavaScript(inner, options, resolvedConfig, false);

      if (!formattedInner) {
        continue;
      }

      const indentPrefix = ' '.repeat(openIndent + indentSize);
      const formattedLines = formattedInner.split('\n').map((line) => (line.length ? `${indentPrefix}${line}` : ''));

      // Re-indent closing delimiter to match opening delimiter
      const closeIndent = ' '.repeat(openIndent);

      lines.splice(i + 1, closeIndex - i - 1, ...formattedLines);
      lines[i + 1 + formattedLines.length] = `${closeIndent}}}`;
      i += formattedLines.length;
    }

    return lines.join('\n');
  }

  private async formatEmbeddedJavaScript(
    rawCode: string,
    options: Partial<FormattingOptions> & CustomFormatterOptions,
    resolvedConfig: Options | null,
    isInline = false
  ): Promise<string | null> {
    const normalized = this.dedent(rawCode).trim();
    if (!normalized) {
      return null;
    }

    try {
      const formatted = await format(normalized, {
        // Always set parser and plugins (required for formatting to work)
        parser: 'babel',
        plugins: [babelPlugin, estreePlugin],
        tabWidth: (options.tabWidth as number) || options.tabSize,
        singleQuote: options.singleQuote,
        trailingComma: options.trailingComma === false ? 'none' : 'all',
        // Then apply resolved config from prettier config files (takes precedence)
        ...(resolvedConfig || {}),
        // For inline expressions, use a very high printWidth to prevent line wrapping
        ...(isInline ? { printWidth: 9999 } : {}),
        semi: false,
      });
      let result = formatted.trimEnd();

      // Prettier can add a defensive leading ';' for parenthesized expressions, arrays,
      // template literals, regex literals, and unary operators.
      // Embedded snippets are isolated, so that prefix can break downstream composition.
      if (!normalized.trimStart().startsWith(';') && /^;(?=[[(`/+\-!~])/.test(result)) {
        result = result.slice(1);
      }

      return result;
    } catch {
      // Keep original block unchanged when embedded code is incomplete or invalid.
      return null;
    }
  }

  private dedent(text: string): string {
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

    if (!nonEmptyLines.length) {
      return text;
    }

    const minIndent = Math.min(...nonEmptyLines.map((line) => this.getLineIndent(line)));
    return lines.map((line) => line.slice(Math.min(minIndent, line.length))).join('\n');
  }

  private getLineIndent(line: string): number {
    return line.length - line.trimStart().length;
  }
}
