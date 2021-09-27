'use strict';
import { compilerType, SolcCompiler } from './solcCompiler';
import Linter from './linter/linter';
import SolhintService from './linter/solhint';
import SoliumService from './linter/solium';
import { CompilerError } from './solErrorsToDiagnostics';
import { CompletionService } from './completionService';
import { SolidityDefinitionProvider } from './definitionProvider';
import {
    createConnection,
    TextDocuments, InitializeResult,

    Diagnostic,
    ProposedFeatures,
    TextDocumentPositionParams,
    CompletionItem, Location, SignatureHelp, TextDocumentSyncKind, VersionedTextDocumentIdentifier,
    WorkspaceFolder
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI, } from 'vscode-uri';

import { SolidityCodeWalker } from './codeWalkerService';
import { Uri } from 'vscode';

interface Settings {
    solidity: SoliditySettings;
}

interface SoliditySettings {
    // option for backward compatibilities, please use "linter" option instead
    linter: boolean | string;
    enabledAsYouTypeCompilationErrorCheck: boolean;
    compileUsingLocalVersion: string;
    compileUsingRemoteVersion: string;
    nodemodulespackage: string;
    defaultCompiler: string;
    soliumRules: any;
    solhintRules: any;
    validationDelay: number;
    packageDefaultDependenciesDirectory: string;
    packageDefaultDependenciesContractsDirectory: string;
}


// import * as path from 'path';
// Create a connection for the server
let connection = createConnection(ProposedFeatures.all);

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

const documents = new TextDocuments(TextDocument);

let rootPath: string;
let solcCompiler: SolcCompiler;
let linter: Linter = null;

let enabledAsYouTypeErrorCheck = false;
let compileUsingRemoteVersion = '';
let compileUsingLocalVersion = '';
let nodeModulePackage = '';
let defaultCompiler = compilerType.embedded;
let solhintDefaultRules = {};
let soliumDefaultRules = {};
let validationDelay = 1500;
let solcCachePath = '';
let hasWorkspaceFolderCapability = false;

// flags to avoid trigger concurrent validations (compiling is slow)
let validatingDocument = false;
let validatingAllDocuments = false;
let packageDefaultDependenciesDirectory = 'lib';
let packageDefaultDependenciesContractsDirectory = 'src';
let workspaceFolders: WorkspaceFolder[];

function initWorkspaceRootFolder(uri: string) {
    if (rootPath !== 'undefined') {
        if (!uri.startsWith(rootPath)) {
            if (workspaceFolders) {

                const newRootFolder = workspaceFolders.find(x => uri.startsWith(x.uri));
                if (newRootFolder !== undefined) {
                    rootPath = URI.parse(newRootFolder.uri).fsPath;
                    solcCompiler.rootPath = rootPath;
                }

            }
        }
    }
}

function validate(document: TextDocument) {
    try {

        initWorkspaceRootFolder(document.uri);
        validatingDocument = true;
        const uri = document.uri;
        const filePath = URI.parse(uri).fsPath;


        const documentText = document.getText();
        let linterDiagnostics: Diagnostic[] = [];
        const compileErrorDiagnostics: Diagnostic[] = [];
        try {
            if (linter !== null) {
                linterDiagnostics = linter.validate(filePath, documentText);
            }
        } catch {
            // gracefull catch
        }

        try {
            if (enabledAsYouTypeErrorCheck) {
                const errors: CompilerError[] = solcCompiler
                    .compileSolidityDocumentAndGetDiagnosticErrors(filePath, documentText,
                        packageDefaultDependenciesDirectory,
                        packageDefaultDependenciesContractsDirectory);
                errors.forEach(errorItem => {
                    const uriCompileError = URI.file(errorItem.fileName);
                    if (uriCompileError.toString() === uri) {
                        compileErrorDiagnostics.push(errorItem.diagnostic);
                    }
                });
            }
        } catch (e) {
            //let x = e;// gracefull catch
        }

        const diagnostics = linterDiagnostics.concat(compileErrorDiagnostics);
        connection.sendDiagnostics({ diagnostics, uri });
    } finally {
        validatingDocument = false;
    }
}



connection.onSignatureHelp((): SignatureHelp => {
    return null;
});

connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    let completionItems = [];
    const document = documents.get(textDocumentPosition.textDocument.uri);
    const service = new CompletionService(rootPath);

    completionItems = completionItems.concat(
        service.getAllCompletionItems2(packageDefaultDependenciesDirectory,
            packageDefaultDependenciesContractsDirectory,
            document,
            textDocumentPosition.position,
        ));
    return completionItems;
});

connection.onDefinition((handler: TextDocumentPositionParams): Thenable<Location | Location[]> => {
    const provider = new SolidityDefinitionProvider(
        rootPath,
        packageDefaultDependenciesDirectory,
        packageDefaultDependenciesContractsDirectory,
    );
    return provider.provideDefinition(documents.get(handler.textDocument.uri), handler.position);
});


// This handler resolve additional information for the item selected in
// the completion list.
// connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
//   item.
// });
function validateAllDocuments() {
    if (!validatingAllDocuments) {
        try {
            validatingAllDocuments = true;
            documents.all().forEach(document => validate(document));
        } finally {
            validatingAllDocuments = false;
        }
    }
}

function startValidation() {
    if (enabledAsYouTypeErrorCheck) {
        solcCompiler.initialiseAllCompilerSettings(compileUsingRemoteVersion, compileUsingLocalVersion, nodeModulePackage, defaultCompiler);
        solcCompiler.initialiseSelectedCompiler().then(() => {
            connection.console.info("Validating using the compiler selected: " + compilerType[defaultCompiler]);
            validateAllDocuments();
        }).catch(reason => {
            connection.console.error("An error has occurred initialising the compiler selected " + compilerType[defaultCompiler] + ", please check your settings, reverting to the embedded compiler. Error: " + reason);
            solcCompiler.initialiseAllCompilerSettings(compileUsingRemoteVersion, compileUsingLocalVersion, nodeModulePackage, compilerType.embedded);
            solcCompiler.initialiseSelectedCompiler().then(() => {
                validateAllDocuments();
            }).catch(reason => { });
        });
    } else {
        validateAllDocuments();
    }
}

documents.onDidChangeContent(event => {
    const document = event.document;

    if (!validatingDocument && !validatingAllDocuments) {
        validatingDocument = true; // control the flag at a higher level
        // slow down, give enough time to type (1.5 seconds?)
        setTimeout(() => validate(document), validationDelay);
    }
});

// remove diagnostics from the Problems panel when we close the file
documents.onDidClose(event => connection.sendDiagnostics({
    diagnostics: [],
    uri: event.document.uri,
}));

documents.listen(connection);

connection.onInitialize((params): InitializeResult => {
    rootPath = params.rootPath;
    let capabilities = params.capabilities;

    hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders;
    }
    solcCachePath = params.initializationOptions;
    solcCompiler = new SolcCompiler(rootPath);
    solcCompiler.setSolcCache(solcCachePath);

    const result: InitializeResult = {
        capabilities: {
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.'],
            },
            definitionProvider: true,
            textDocumentSync: TextDocumentSyncKind.Full,
        },
    };

    if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            if (connection.workspace !== undefined) {
                connection.workspace.onDidChangeWorkspaceFolders((event) => {
                    event.removed.forEach(workspaceFolder => {
                        const index = workspaceFolders.findIndex((folder) => folder.uri === workspaceFolder.uri);
                        if (index !== -1) {
                            workspaceFolders.splice(index, 1);
                        }
                    });
                    event.added.forEach(workspaceFolder => {

                        workspaceFolders.push(workspaceFolder);

                    });

                });
            };
        });
    }
});


connection.onDidChangeConfiguration((change) => {
    const settings = <Settings>change.settings;
    enabledAsYouTypeErrorCheck = settings.solidity.enabledAsYouTypeCompilationErrorCheck;
    compileUsingLocalVersion = settings.solidity.compileUsingLocalVersion;
    compileUsingRemoteVersion = settings.solidity.compileUsingRemoteVersion;
    solhintDefaultRules = settings.solidity.solhintRules;
    soliumDefaultRules = settings.solidity.soliumRules;
    validationDelay = settings.solidity.validationDelay;
    nodeModulePackage = settings.solidity.nodemodulespackage;
    defaultCompiler = compilerType[settings.solidity.defaultCompiler];
    packageDefaultDependenciesContractsDirectory = settings.solidity.packageDefaultDependenciesContractsDirectory;
    packageDefaultDependenciesDirectory = settings.solidity.packageDefaultDependenciesDirectory;

    switch (linterName(settings.solidity)) {
        case 'solhint': {
            linter = new SolhintService(rootPath, solhintDefaultRules);
            break;
        }
        case 'solium': {
            linter = new SoliumService(rootPath, soliumDefaultRules, connection);
            break;
        }
        default: {
            linter = null;
        }
    }

    if (linter !== null) {
        linter.setIdeRules(linterRules(settings.solidity));
    }

    startValidation();
});

function linterName(settings: SoliditySettings) {
    return settings.linter;
}

function linterRules(settings: SoliditySettings) {
    const _linterName = linterName(settings);
    if (_linterName === 'solium') {
        return settings.soliumRules;
    } else {
        return settings.solhintRules;
    }
}

connection.listen();
