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
  private static readonly VARIABLE_PLACEHOLDER_PREFIX = '$PLH';

  public configure(shouldFormat: LanguageSettings): void {
    if (shouldFormat) {
      this.formatterEnabled = shouldFormat.format;
    }
  }

  private isSqlConfigFile(uri: string): boolean {
    // Check if the file path matches configs/sql.*.yml pattern
    return /\/configs\/sql\.[^/]*\.yml$/.test(uri);
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

      // Resolve prettier config only for real file URIs.
      // Synthetic/test URIs should rely on explicit formatter options/defaults.
      const resolvedConfig = document.uri.startsWith('file://')
        ? await resolveConfig(document.uri.replace(/^file:\/\//, ''))
        : null;

      const prettierOptions: Options = {
        parser: 'yaml',
        plugins: [yamlPlugin, estreePlugin],
        ...(resolvedConfig || {}),
        // Prefer resolved Prettier config; use request options only as fallback.
        tabWidth:
          (resolvedConfig?.tabWidth as number) ??
          (options.tabWidth as number) ??
          options.tabSize ??
          YAMLFormatter.INDENT_FALLBACK,
        singleQuote: resolvedConfig?.singleQuote ?? options.singleQuote,
        bracketSpacing: resolvedConfig?.bracketSpacing ?? options.bracketSpacing,
        // 'preserve' is the default for Options.proseWrap. See also server.ts
        proseWrap:
          resolvedConfig?.proseWrap ??
          (options.proseWrap === 'always' ? 'always' : options.proseWrap === 'never' ? 'never' : 'preserve'),
        printWidth: (resolvedConfig?.printWidth as number) ?? options.printWidth,
        trailingComma:
          resolvedConfig?.trailingComma ??
          (options.trailingComma === false ? 'none' : options.trailingComma === true ? 'all' : 'all'),
      };

      const formatted = await format(text, prettierOptions);
      const formattedWithInlineEmbeddedJs = await this.formatInlineEmbeddedJavaScriptExpressions(
        formatted,
        options,
        resolvedConfig,
        document.uri
      );
      const formattedWithEmbeddedJs = await this.formatEmbeddedJavaScriptBlocks(
        formattedWithInlineEmbeddedJs,
        options,
        resolvedConfig,
        document.uri
      );

      return [TextEdit.replace(Range.create(Position.create(0, 0), document.positionAt(text.length)), formattedWithEmbeddedJs)];
    } catch (error) {
      console.error('Error formatting document:\n' + document.uri.toString() + '\nError message:\n' + error);
      return [];
    }
  }

  private async formatInlineEmbeddedJavaScriptExpressions(
    text: string,
    options: Partial<FormattingOptions> & CustomFormatterOptions,
    resolvedConfig: Options | null,
    documentUri: string
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

        const formattedInner = await this.formatEmbeddedJavaScript(inner, options, resolvedConfig, documentUri, true);
        if (formattedInner) {
          let inlineInner = formattedInner.trim();

          // Keep non-SQL inline expressions single-line even when Prettier breaks groups.
          // SQL config files intentionally preserve line breaks for readability/placeholders.
          if (!this.isSqlConfigFile(documentUri) && inlineInner.includes('\n')) {
            inlineInner = inlineInner
              .replace(/\s*\n\s*/g, ' ')
              .replace(/\s+/g, ' ')
              // Remove collapse-induced spaces just inside parentheses.
              .replace(/\(\s+/g, '(')
              .replace(/\s+\)/g, ')')
              // Remove collapse-induced spaces before method/property chains.
              .replace(/\s+\.(?=[A-Za-z_$])/g, '.')
              .trim();
          }

          replacement = `\${{ ${inlineInner} }}`;
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
    resolvedConfig: Options | null,
    documentUri: string
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
      const formattedInner = await this.formatEmbeddedJavaScript(inner, options, resolvedConfig, documentUri, false);

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
    documentUri: string,
    isInline = false
  ): Promise<string | null> {
    const normalized = this.dedent(rawCode).trim();
    if (!normalized) {
      return null;
    }

    // For SQL config files, replace ${variable_name} with indexed placeholders before formatting
    const isSqlConfig = this.isSqlConfigFile(documentUri);
    let codeToFormat = normalized;
    let replacements: Map<string, string> = new Map();

    if (isSqlConfig) {
      const result = this.replaceSqlVariablePlaceholders(normalized);
      codeToFormat = result.code;
      replacements = result.replacements;
    }

    try {
      const formatted = await format(codeToFormat, {
        // Always set parser and plugins (required for formatting to work)
        parser: 'babel',
        plugins: [babelPlugin, estreePlugin],
        ...(resolvedConfig || {}),
        tabWidth:
          (resolvedConfig?.tabWidth as number) ??
          (options.tabWidth as number) ??
          options.tabSize ??
          YAMLFormatter.INDENT_FALLBACK,
        singleQuote: resolvedConfig?.singleQuote ?? options.singleQuote,
        trailingComma:
          resolvedConfig?.trailingComma ??
          (options.trailingComma === false ? 'none' : options.trailingComma === true ? 'all' : 'all'),
        // For non-SQL inline expressions, always force a very high printWidth
        // to prevent unwanted line wrapping before inline reconstruction.
        ...(isInline && !isSqlConfig ? { printWidth: 9999 } : {}),
        semi: false,
      });
      let result = formatted.trimEnd();

      // Prettier can add a defensive leading ';' before certain expressions
      // (for example: parenthesized, arrays, template literals, regex, async/unary starts).
      // Embedded snippets are isolated, so that prefixed semicolon can break downstream composition.
      if (!normalized.trimStart().startsWith(';') && result.startsWith(';')) {
        result = result.slice(1);
      }

      // For SQL config files, revert indexed placeholders back to ${variable_name}
      if (isSqlConfig) {
        result = this.revertSqlVariablePlaceholders(result, replacements);
      }

      return result;
    } catch (error) {
      // Keep original block unchanged when embedded code is incomplete or invalid.
      console.error('Error formatting embedded JavaScript:\n' + codeToFormat + '\nError message:\n' + error);
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

  /**
   * Replace ${variable_name} with indexed placeholders ($PLH0, $PLH1, etc.) for SQL config files.
   * This is used to temporarily transform invalid JS syntax to valid syntax before formatting.
   * Important: This replaces ${...} that are NOT template literal syntax, including:
   *   - ${var} outside template literals
   *   - ${var} inside template expressions like `text ${${var}}`
   * Returns the modified code and a map of placeholder -> original variable name.
   */
  private replaceSqlVariablePlaceholders(code: string): { code: string; replacements: Map<string, string> } {
    const replacements = new Map<string, string>();
    let counter = 0;
    let result = '';
    let inTemplateLiteral = false;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let templateExpressionDepth = 0; // Track depth inside template expressions ${...}

    for (let i = 0; i < code.length; i++) {
      const char = code[i];

      // Handle escape sequences
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        result += char;
        continue;
      }

      // Track template literals
      if (char === '`' && !inString) {
        inTemplateLiteral = !inTemplateLiteral;
        if (!inTemplateLiteral) {
          // Exiting template literal, reset expression depth
          templateExpressionDepth = 0;
        }
        result += char;
        continue;
      }

      // Track regular strings (but not when inside template literals)
      if ((char === '"' || char === "'") && !inTemplateLiteral) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
          stringChar = '';
        }
        result += char;
        continue;
      }

      // Handle ${...} patterns
      if (char === '$' && i + 1 < code.length && code[i + 1] === '{') {
        // Check if this is the START of a template expression (not a custom variable to replace)
        if (inTemplateLiteral && templateExpressionDepth === 0) {
          // This is the opening of a template expression ${...}
          // Don't replace, but start tracking the expression depth
          templateExpressionDepth = 1;
          result += '${';
          i++; // Skip the '{'
          continue;
        }

        // Determine if we should replace this ${...}
        // - Replace if NOT in template literal and NOT in string
        // - Replace if INSIDE a template expression (depth > 0)
        const shouldReplace = (!inTemplateLiteral && !inString) || templateExpressionDepth > 0;

        if (shouldReplace) {
          // Find the closing brace
          let depth = 0;
          let j = i + 1;
          while (j < code.length) {
            if (code[j] === '{') depth++;
            if (code[j] === '}') {
              depth--;
              if (depth === 0) break;
            }
            j++;
          }

          if (j < code.length && depth === 0) {
            // Extract variable name
            const varName = code.substring(i + 2, j);
            const originalLength = j - i + 1; // Length of ${varName} including braces
            const placeholder = `${YAMLFormatter.VARIABLE_PLACEHOLDER_PREFIX}${counter}`;

            // Pad the placeholder to match original length so line-wrapping behavior is preserved
            const paddedPlaceholder = placeholder.padEnd(originalLength, '_');

            replacements.set(paddedPlaceholder, varName);
            result += paddedPlaceholder;
            counter++;
            i = j; // Skip past the closing brace
            continue;
          }
        }
      }

      // Track braces inside template expressions to know when we exit
      if (inTemplateLiteral && templateExpressionDepth > 0) {
        if (char === '{') {
          templateExpressionDepth++;
        } else if (char === '}') {
          templateExpressionDepth--;
        }
      }

      result += char;
    }

    return { code: result, replacements };
  }

  /**
   * Revert indexed placeholders ($PLH0, $PLH1, etc.) back to ${variable_name} for SQL config files.
   */
  private revertSqlVariablePlaceholders(code: string, replacements: Map<string, string>): string {
    let result = code;
    for (const [placeholder, varName] of replacements) {
      // Use a simple string replace for each placeholder
      // This is safe because placeholders are unique indexed values
      result = result.split(placeholder).join(`\${${varName}}`);
    }
    return result;
  }
}
