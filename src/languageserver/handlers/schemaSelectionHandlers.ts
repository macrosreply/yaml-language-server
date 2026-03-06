/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { JSONSchema } from '../../languageservice/jsonSchema';
import { yamlDocumentsCache } from '../../languageservice/parser/yaml-documents';
import { YAMLSchemaService } from '../../languageservice/services/yamlSchemaService';
import { getSchemaUrls } from '../../languageservice/utils/schemaUrls';
import {
  JSONSchemaDescription,
  JSONSchemaDescriptionExt,
  SchemaSelectionRequests,
  VSCodeContentRequest,
} from '../../requestTypes';
import { SettingsState } from '../../yamlSettings';

export class JSONSchemaSelection {
  constructor(
    private readonly schemaService: YAMLSchemaService,
    private readonly yamlSettings?: SettingsState,
    private readonly connection?: Connection
  ) {
    this.connection?.onRequest(SchemaSelectionRequests.getSchema, (fileUri) => {
      return this.getSchemas(fileUri);
    });
    this.connection?.onRequest(SchemaSelectionRequests.getAllSchemas, (fileUri) => {
      return this.getAllSchemas(fileUri);
    });
  }

  async getSchemas(docUri: string): Promise<JSONSchemaDescription[]> {
    const schemas = await this.getSchemasForFile(docUri);
    return Array.from(schemas).map((val) => {
      return {
        name: val[1].title,
        uri: val[0],
        description: val[1].description,
        versions: val[1].versions,
      };
    });
  }

  /**
   * Get or fetch a document by URI
   * First tries to get from tracked documents, then attempts to fetch via VS Code if available
   */
  private async getOrFetchDocument(docUri: string): Promise<TextDocument | undefined> {
    // First try to get from tracked documents
    let document = this.yamlSettings?.documents.get(docUri);
    if (document) {
      return document;
    }

    // If not found and connection is available, try to fetch the content
    if (this.connection && this.yamlSettings?.useVSCodeContentRequest) {
      try {
        const content = await this.connection.sendRequest(VSCodeContentRequest.type, docUri);
        if (content) {
          // Create a temporary TextDocument from the fetched content
          document = TextDocument.create(docUri, 'yaml', 0, content);
          return document;
        }
      } catch (error) {
        // VSCodeContentRequest failed, will try filesystem fallback
      }
    }

    // Fallback: Try to read file:// URIs directly from filesystem
    try {
      const uri = URI.parse(docUri);
      if (uri.scheme === 'file') {
        const content = await fs.readFile(uri.fsPath, 'utf-8');
        document = TextDocument.create(docUri, 'yaml', 0, content);
        return document;
      }
    } catch (error) {
      // File read failed, document will remain undefined
    }

    return undefined;
  }

  private async getSchemasForFile(docUri: string): Promise<Map<string, JSONSchema>> {
    const document = await this.getOrFetchDocument(docUri);
    const schemas = new Map<string, JSONSchema>();
    if (!document) {
      return schemas;
    }

    const yamlDoc = yamlDocumentsCache.getYamlDocument(document);

    for (const currentYAMLDoc of yamlDoc.documents) {
      const schema = await this.schemaService.getSchemaForResource(document.uri, currentYAMLDoc);
      if (schema?.schema) {
        const schemaUrls = getSchemaUrls(schema?.schema);
        if (schemaUrls.size === 0) {
          continue;
        }
        for (const urlToSchema of schemaUrls) {
          schemas.set(urlToSchema[0], urlToSchema[1]);
        }
      }
    }
    return schemas;
  }

  async getAllSchemas(docUri: string): Promise<JSONSchemaDescriptionExt[]> {
    const fileSchemas = await this.getSchemasForFile(docUri);
    const fileSchemasHandle: JSONSchemaDescriptionExt[] = Array.from(fileSchemas.entries()).map((val) => {
      return {
        uri: val[0],
        fromStore: false,
        usedForCurrentFile: true,
        name: val[1].title,
        description: val[1].description,
        versions: val[1].versions,
      };
    });
    const result = [];
    let allSchemas = this.schemaService.getAllSchemas();
    allSchemas = allSchemas.filter((val) => !fileSchemas.has(val.uri));
    result.push(...fileSchemasHandle);
    result.push(...allSchemas);

    return result;
  }
}
