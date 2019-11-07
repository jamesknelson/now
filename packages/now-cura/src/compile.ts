import { readFileSync, lstatSync } from 'fs';
import { relative, resolve } from 'path';
import nodeFileTrace from '@zeit/node-file-trace';
import {
  glob,
  File,
  FileBlob,
  FileFsRef,
  Files,
  debug,
} from '@now/build-utils';

interface CompilerConfig {
  debug?: boolean;
  includeFiles?: string | string[];
  excludeFiles?: string | string[];
}

export async function compile(
  workPath: string,
  entrypointPath: string,
  config: CompilerConfig
): Promise<{
  preparedFiles: Files;
  watch: string[];
}> {
  const inputFiles = new Set<string>([entrypointPath]);

  const sourceCache = new Map<string, string | Buffer | null>();
  const fsCache = new Map<string, File>();

  if (config.includeFiles) {
    const includeFiles =
      typeof config.includeFiles === 'string'
        ? [config.includeFiles]
        : config.includeFiles;

    for (const pattern of includeFiles) {
      const files = await glob(pattern, workPath);
      await Promise.all(
        Object.keys(files).map(async file => {
          const entry: FileFsRef = files[file];
          fsCache.set(file, entry);
          const stream = entry.toStream();
          const { data } = await FileBlob.fromStream({ stream });
          sourceCache.set(file, data);
          inputFiles.add(resolve(workPath, file));
        })
      );
    }
  }

  debug(
    'Tracing input files: ' +
      [...inputFiles].map(p => relative(workPath, p)).join(', ')
  );

  const preparedFiles: Files = {};

  const { fileList, warnings } = await nodeFileTrace([...inputFiles], {
    base: workPath,
    mixedModules: true,
    ignore: config.excludeFiles,
    readFile(fsPath: string): Buffer | string | null {
      const relPath = relative(workPath, fsPath);
      const cached = sourceCache.get(relPath);
      if (cached) return cached.toString();
      // null represents a not found
      if (cached === null) return null;
      try {
        const source: string | Buffer = readFileSync(fsPath);
        const { mode } = lstatSync(fsPath);
        const entry = new FileBlob({ data: source, mode });
        fsCache.set(relPath, entry);
        sourceCache.set(relPath, source);
        return source.toString();
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') {
          sourceCache.set(relPath, null);
          return null;
        }
        throw e;
      }
    },
  });

  for (const path of fileList) {
    let entry = fsCache.get(path);
    if (!entry) {
      const fsPath = resolve(workPath, path);
      const { mode } = lstatSync(fsPath);
      const source = readFileSync(fsPath);
      entry = new FileBlob({ data: source, mode });
    }
    preparedFiles[path] = entry;
  }

  for (const warning of warnings) {
    if (warning && warning.stack) {
      debug(warning.stack.replace('Error: ', 'Warning: '));
    }
  }

  return {
    preparedFiles,
    watch: fileList,
  };
}
