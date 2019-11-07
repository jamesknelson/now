import ms from 'ms';
import path from 'path';
import spawn from 'cross-spawn';
import getPort from 'get-port';
import isPortReachable from 'is-port-reachable';
import { ChildProcess, SpawnOptions } from 'child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import {
  glob,
  createLambda,
  download,
  runNpmInstall,
  runPackageJsonScript,
  getNodeVersion,
  getSpawnOptions,
  Files,
  FileBlob,
  FileFsRef,
  Route,
  BuildOptions,
  Config,
  debug,
  PackageJson,
  PrepareCacheOptions,
} from '@now/build-utils';
import { compile } from './compile';
import { makeNowLauncher } from './launcher';

const sleep = (n: number) => new Promise(resolve => setTimeout(resolve, n));

const DEV_SERVER_PORT_BIND_TIMEOUT = ms('5m');

const LAUNCHER_FILENAME = '___now_launcher';
const BRIDGE_FILENAME = '___now_bridge';
const HELPERS_FILENAME = '___now_helpers';
const SOURCEMAP_SUPPORT_FILENAME = '__sourcemap_support';

async function checkForPort(
  port: number | undefined,
  timeout: number
): Promise<void> {
  const start = Date.now();
  while (!(await isPortReachable(port))) {
    if (Date.now() - start > timeout) {
      throw new Error(`Detecting port ${port} timed out after ${ms(timeout)}`);
    }
    await sleep(100);
  }
}

function validateDistDir(
  distDir: string,
  isDev: boolean | undefined,
  config: Config
) {
  const distDirName = path.basename(distDir);
  const exists = () => existsSync(distDir);
  const isDirectory = () => statSync(distDir).isDirectory();
  const isEmpty = () => readdirSync(distDir).length === 0;

  const hash = isDev
    ? '#local-development'
    : '#configuring-the-build-output-directory';
  const docsUrl = `https://zeit.co/docs/v2/deployments/official-builders/static-build-now-static-build${hash}`;

  const info = config.zeroConfig
    ? '\nMore details: https://zeit.co/docs/v2/platform/frequently-asked-questions#missing-public-directory'
    : `\nMake sure you configure the the correct distDir: ${docsUrl}`;

  if (!exists()) {
    throw new Error(`No output directory named "${distDirName}" found.${info}`);
  }

  if (!isDirectory()) {
    throw new Error(
      `Build failed because distDir is not a directory: "${distDirName}".${info}`
    );
  }

  if (isEmpty()) {
    throw new Error(
      `Build failed because distDir is empty: "${distDirName}".${info}`
    );
  }
}

function getCommand(pkg: PackageJson, cmd: string, { zeroConfig }: Config) {
  // The `dev` script can be `now dev`
  const nowCmd = `now-${cmd}`;

  if (!zeroConfig && cmd === 'dev') {
    return nowCmd;
  }

  const scripts = (pkg && pkg.scripts) || {};

  if (scripts[nowCmd]) {
    return nowCmd;
  }

  if (scripts[cmd]) {
    return cmd;
  }

  return zeroConfig ? cmd : nowCmd;
}

export const version = 2;

const nowDevScriptPorts = new Map<string, number>();
const nowDevChildProcesses = new Set<ChildProcess>();

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.once(signal as NodeJS.Signals, () => {
    for (const child of nowDevChildProcesses) {
      debug(
        `Got ${signal}, killing dev server child process (pid=${child.pid})`
      );
      process.kill(child.pid, signal);
    }
    process.exit(0);
  });
});

const getDevRoute = (srcBase: string, devPort: number, route: Route) => {
  const basic: Route = {
    src: `${srcBase}${route.src}`,
    dest: `http://localhost:${devPort}${route.dest}`,
  };

  if (route.headers) {
    basic.headers = route.headers;
  }

  return basic;
};

export async function build({
  files,
  entrypoint,
  workPath,
  config,
  meta = {},
}: BuildOptions) {
  debug('Downloading user files...');
  await download(files, workPath, meta);

  const mountpoint = path.dirname(entrypoint);
  const entrypointDir = path.join(workPath, mountpoint);

  const buildPath = path.join(workPath, path.dirname(entrypoint), 'build');

  const distPath = path.join(buildPath, 'web');
  const renderPath = path.join(buildPath, 'node', 'index.js');

  const pkgPath = path.join(workPath, entrypoint);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;

  let output: Files = {};
  const routes: Route[] = [];

  const nodeVersion = await getNodeVersion(entrypointDir, undefined, config);
  const spawnOpts = getSpawnOptions(meta, nodeVersion);

  console.log('Installing dependencies...');
  await runNpmInstall(entrypointDir, ['--prefer-offline'], spawnOpts, meta);

  if (meta.isDev && pkg.scripts && pkg.scripts.start) {
    let devPort: number | undefined = nowDevScriptPorts.get(entrypoint);

    if (typeof devPort === 'number') {
      debug('server already running for %j', entrypoint);
    } else {
      // Run the `now-dev` or `dev` script out-of-bounds, since it is assumed that
      // it will launch a dev server that never "completes"
      devPort = await getPort();
      nowDevScriptPorts.set(entrypoint, devPort);

      const opts: SpawnOptions = {
        cwd: entrypointDir,
        stdio: 'inherit',
        env: { ...process.env, PORT: String(devPort) },
      };

      const child: ChildProcess = spawn('yarn', ['start'], opts);
      child.on('exit', () => nowDevScriptPorts.delete(entrypoint));
      nowDevChildProcesses.add(child);

      // Now wait for the server to have listened on `$PORT`, after which we
      // will ProxyPass any requests to that development server that come in
      // for this builder.
      try {
        await checkForPort(devPort, DEV_SERVER_PORT_BIND_TIMEOUT);
      } catch (err) {
        throw new Error(
          `Failed to detect a server running on port ${devPort}.\nDetails: https://err.sh/zeit/now/now-static-build-failed-to-detect-a-server`
        );
      }

      debug('Detected dev server for %j', entrypoint);
    }

    let srcBase = mountpoint.replace(/^\.\/?/, '');

    if (srcBase.length > 0) {
      srcBase = `/${srcBase}`;
    }

    // We ignore defaultRoutes for `now dev`
    // since in this case it will get proxied to
    // a custom server we don't have control over
    routes.push(
      getDevRoute(srcBase, devPort, {
        src: '/(.*)',
        dest: '/$1',
      })
    );
  } else {
    if (meta.isDev) {
      debug(`WARN: "start" script is missing from package.json`);
      debug(
        'See the local development docs: https://zeit.co/docs/v2/deployments/official-builders/static-build-now-static-build/#local-development'
      );
    }

    const buildScript = getCommand(pkg, 'build', config as Config);
    debug(`Running "${buildScript}" script in "${entrypoint}"`);

    const found = await runPackageJsonScript(
      entrypointDir,
      buildScript,
      spawnOpts
    );

    if (!found) {
      throw new Error(
        `Missing required "${buildScript}" script in "${entrypoint}"`
      );
    }

    validateDistDir(distPath, meta.isDev, config);

    routes.push(
      ...[
        {
          src: '/static/(.*)',
          headers: { 'cache-control': 's-maxage=31536000, immutable' },
          continue: true,
        },
        {
          src: '/service-worker.js',
          headers: { 'cache-control': 's-maxage=0' },
          continue: true,
        },
        {
          src: '/sockjs-node/(.*)',
          dest: '/sockjs-node/$1',
        },
        {
          handle: 'filesystem',
        },
        {
          src: '/(.*)',
          dest: '/render.js',
        },
      ]
    );

    output = await glob('**', distPath, mountpoint);
  }

  // Use the system-installed version of `node` when running via `now dev`
  const runtime = meta.isDev ? 'nodejs' : nodeVersion.runtime;

  debug('Tracing input files...');
  const traceTime = Date.now();
  const { preparedFiles, watch } = await compile(workPath, renderPath, config);
  debug(`Trace complete [${Date.now() - traceTime}ms]`);

  const launcherFiles: Files = {
    [`${LAUNCHER_FILENAME}.js`]: new FileBlob({
      data: makeNowLauncher({
        entrypointPath: `./build/node/index.js`,
        bridgePath: `./${BRIDGE_FILENAME}`,
        helpersPath: `./${HELPERS_FILENAME}`,
        sourcemapSupportPath: `./${SOURCEMAP_SUPPORT_FILENAME}`,
        shouldAddHelpers: true,
      }),
    }),
    [`${BRIDGE_FILENAME}.js`]: new FileFsRef({
      fsPath: path.join(__dirname, 'bridge.js'),
    }),
    [`${HELPERS_FILENAME}.js`]: new FileFsRef({
      fsPath: path.join(__dirname, 'helpers.js'),
    }),
  };

  const lambda = await createLambda({
    files: {
      ...preparedFiles,
      ...launcherFiles,
    },
    handler: `${LAUNCHER_FILENAME}.launcher`,
    runtime,
  });

  output['render.js'] = lambda as any;

  return {
    routes,
    watch: watch.concat(path.join(mountpoint.replace(/^\.\/?/, ''), '**/*')),
    output,
    distPath: distPath,
  };
}

export async function prepareCache({ workPath }: PrepareCacheOptions) {
  return {
    ...(await glob('node_modules/**', workPath)),
    ...(await glob('package-lock.json', workPath)),
    ...(await glob('yarn.lock', workPath)),
  };
}
