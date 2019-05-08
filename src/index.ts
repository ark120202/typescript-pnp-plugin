import path from 'path';
import { getResolvedValue, ResolutionResult, resolveModuleName, walkUp } from 'tsc-pnp/lib/utils';
import * as ts_module from 'typescript/lib/tsserverlibrary';

const formatResolutionFailedMessage = (
  type: string,
  pnpPath: string | undefined,
  containingFile: string,
  name: string,
  result: ResolutionResult,
) =>
  [
    `${type} resolution request failed`,
    `    PnP: ${pnpPath || 'no'}`,
    `    From: ${containingFile}`,
    `    Request: ${name}`,
    `    Result: ${JSON.stringify(result)}`,
  ].join('\n');

class ProjectHandler {
  constructor(
    private ts: typeof ts_module,
    private project: ts_module.server.Project,
    private serverHost: ts_module.server.ServerHost,
  ) {
    this.patch();
    this.watch();

    this.log(`reloading config to resolve extended references`);
    this.reloadOptions();
  }

  private log(message: string) {
    this.project.log(`[typescript-pnp-plugin] ${this.project.projectName}: ${message}`);
  }

  private watch() {
    const pnpProjects = new Map<string, boolean>();
    const inferPnpProject = () => {
      for (const [directory, exists] of pnpProjects) {
        if (exists) {
          this.setPnpProject(directory);
          return;
        }
      }

      this.setPnpProject(undefined);
    };

    const cwd = this.project.getCurrentDirectory();
    for (const directory of walkUp(cwd)) {
      const pnpPath = path.join(directory, '.pnp.js');

      pnpProjects.set(pnpPath, this.serverHost.fileExists(pnpPath));
      this.serverHost.watchFile(pnpPath, (_, eventKind) => {
        pnpProjects.set(pnpPath, eventKind !== this.ts.FileWatcherEventKind.Deleted);
        inferPnpProject();
        this.log('refreshing project files');
        this.refreshFiles();
      });
    }

    inferPnpProject();
  }

  private patch() {
    const resolveAndLog = <T extends ResolutionResult>(
      type: string,
      name: string,
      containingFile: string,
      parentResolver: (
        request: string,
        issuer: string,
        options: ts_module.CompilerOptions,
        host: ts_module.ModuleResolutionHost,
      ) => T,
    ): T => {
      const options = this.project.getCompilerOptions();
      const result = resolveModuleName(
        this.pnpPath,
        name,
        containingFile,
        this.project,
        (request, issuer) => parentResolver(request, issuer, options, this.project),
      );

      if (!getResolvedValue(result)) {
        this.log(formatResolutionFailedMessage(type, this.pnpPath, containingFile, name, result));
      }

      return result;
    };

    this.project.resolveModuleNames = (moduleNames, containingFile, _reusedNames) =>
      moduleNames.map(
        name =>
          resolveAndLog('resolveModuleNames', name, containingFile, this.ts.resolveModuleName)
            .resolvedModule,
      );

    this.project.resolveTypeReferenceDirectives = (typeDirectiveNames, containingFile) =>
      typeDirectiveNames.map(
        name =>
          resolveAndLog(
            'resolveTypeReferenceDirectives',
            name,
            containingFile,
            this.ts.resolveTypeReferenceDirective,
          ).resolvedTypeReferenceDirective,
      );
  }

  public pnpPath?: string;
  private setPnpProject(pnpPath?: string) {
    if (pnpPath) {
      delete require.cache[require.resolve(pnpPath)];
      this.log(`updated PnP API${this.pnpPath !== pnpPath ? ` to '${pnpPath}'` : ''}`);
    } else {
      this.log(`removed PnP API`);
    }

    this.pnpPath = pnpPath;
  }

  private refreshFiles() {
    (this.project as any).onChangedAutomaticTypeDirectiveNames();
    (this.project.projectService as any).delayUpdateProjectGraphs([this.project]);
    (this.project.projectService as any).filenameToScriptInfo.forEach((info: any) => {
      info.delayReloadNonMixedContentFile();
    });
  }

  private reloadOptions() {
    (this.project.projectService as any).onConfigChangedForConfiguredProject(
      this.project,
      this.ts.FileWatcherEventKind.Changed,
    );
  }
}

class Plugin {
  private projects = new Map<ts_module.server.Project, ProjectHandler>();
  private ts!: typeof ts_module;
  public setTypeScript(typescript: typeof ts_module) {
    this.ts = typescript;
  }

  public useProject({ project, serverHost }: ts_module.server.PluginCreateInfo) {
    if (this.projects.size === 0) {
      this.patchConfigFileResolver();
    }

    if (!this.projects.has(project)) {
      this.projects.set(project, new ProjectHandler(this.ts, project, serverHost));
    }
  }

  private log(message: string) {
    for (const project of this.projects.keys()) {
      project.log(`[typescript-pnp-plugin] ${message}`);
      break;
    }
  }

  private patchConfigFileResolver() {
    const nodeModuleNameResolver = this.ts.nodeModuleNameResolver;

    // There is an internal lookupConfig argument
    this.ts.nodeModuleNameResolver = (name, containingFile, compilerOptions, host, ...args) => {
      if ((args[args.length - 1] as any) === true) {
        const projectsWithPnp = [...this.projects.values()].filter(({ pnpPath }) => pnpPath);
        if (projectsWithPnp.length > 0) {
          const { pnpPath } = projectsWithPnp[0];

          const result = resolveModuleName(pnpPath, name, containingFile, host, (request, issuer) =>
            nodeModuleNameResolver(request, issuer, compilerOptions, host, ...args),
          );

          if (!getResolvedValue(result)) {
            this.log(
              formatResolutionFailedMessage('config file', pnpPath, containingFile, name, result),
            );
          }

          return result;
        }
      }

      return nodeModuleNameResolver(name, containingFile, compilerOptions, host, ...args);
    };
  }
}

const plugin = new Plugin();
const init: ts_module.server.PluginModuleFactory = ({ typescript }) => {
  plugin.setTypeScript(typescript);
  return {
    create(createInfo) {
      plugin.useProject(createInfo);
      return createInfo.languageService;
    },
  };
};

export = init;
