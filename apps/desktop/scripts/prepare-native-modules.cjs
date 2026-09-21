const { execFileSync, spawn } = require("node:child_process");
const {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const path = require("node:path");

const desktopPackageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopPackageRoot, "..", "..");

const NODE_MODULES_DIRECTORY = "node_modules";
const NODE_PTY_PACKAGE_NAME = "node-pty";
const BETTER_SQLITE3_PACKAGE_NAME = "better-sqlite3";
const UNIVERSAL_ARCH = "universal";
const DARWIN_PLATFORM = "darwin";
const MAC_UNIVERSAL_ARCHITECTURES = ["arm64", "x64"];
const BETTER_SQLITE3_NODE_RELATIVE_PATH = path.join(
  "build",
  "Release",
  "better_sqlite3.node",
);
const ELECTRON_HEADERS_DIST_URL = "https://electronjs.org/headers";
const LIPO_ARCH_NAMES = { arm64: "arm64", x64: "x86_64" };
const PACKAGED_NATIVE_PACKAGE_NAMES = [
  NODE_PTY_PACKAGE_NAME,
  BETTER_SQLITE3_PACKAGE_NAME,
];

const NODE_PTY_PREBUILD_PLATFORMS = ["darwin-arm64", "darwin-x64"];
const NODE_PTY_SPAWN_HELPER_RELATIVE_PATHS = [
  path.join("build", "Release", "spawn-helper"),
  ...NODE_PTY_PREBUILD_PLATFORMS.map((platform) =>
    path.join("prebuilds", platform, "spawn-helper"),
  ),
];
const NODE_PTY_ASAR_HELPER_PATH_REWRITE =
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
const NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE =
  "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked');";

async function isDirectory(directoryPath) {
  try {
    const entry = await readdir(directoryPath, { withFileTypes: true });
    return Array.isArray(entry);
  } catch {
    return false;
  }
}

function packageNameForNodeModulesDirectory(directoryPath) {
  const parentDirectory = path.dirname(directoryPath);
  if (path.basename(parentDirectory) === NODE_MODULES_DIRECTORY) {
    return path.basename(directoryPath);
  }

  const nodeModulesDirectory = path.dirname(parentDirectory);
  if (
    path.basename(nodeModulesDirectory) === NODE_MODULES_DIRECTORY &&
    path.basename(parentDirectory).startsWith("@")
  ) {
    return `${path.basename(parentDirectory)}/${path.basename(directoryPath)}`;
  }

  return undefined;
}

async function findPackageDirectories(rootPath, packageNames) {
  const packageNameSet = new Set(packageNames);
  const matches = new Map(packageNames.map((packageName) => [packageName, []]));
  const pending = [rootPath];

  while (pending.length > 0) {
    const directoryPath = pending.pop();
    if (directoryPath === undefined) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childPath = path.join(directoryPath, entry.name);
      const packageName = packageNameForNodeModulesDirectory(childPath);
      if (packageName !== undefined && packageNameSet.has(packageName)) {
        matches.get(packageName).push(childPath);
        continue;
      }
      pending.push(childPath);
    }
  }

  return matches;
}

async function chmodIfPresent(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function patchNodePtyHelperPath(packageDirectory) {
  const unixTerminalPath = path.join(
    packageDirectory,
    "lib",
    "unixTerminal.js",
  );
  const source = await readFile(unixTerminalPath, "utf8");

  if (source.includes(NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE)) {
    return;
  }
  if (!source.includes(NODE_PTY_ASAR_HELPER_PATH_REWRITE)) {
    throw new Error(
      `Unable to patch ${NODE_PTY_PACKAGE_NAME} helper path rewrite in ${unixTerminalPath}`,
    );
  }

  await writeFile(
    unixTerminalPath,
    source.replace(
      NODE_PTY_ASAR_HELPER_PATH_REWRITE,
      NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE,
    ),
  );
}

async function prepareNodePtyPackageDirectory(packageDirectory) {
  await patchNodePtyHelperPath(packageDirectory);

  await Promise.all(
    NODE_PTY_SPAWN_HELPER_RELATIVE_PATHS.map((relativePath) =>
      chmodIfPresent(path.join(packageDirectory, relativePath), 0o755),
    ),
  );
}

function resolveBetterSqlite3PrebuildArguments({
  electronVersion,
  arch,
  platform,
}) {
  return [
    "--runtime=electron",
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    `--platform=${platform}`,
  ];
}

async function runNodeScript(
  scriptPath,
  scriptArguments,
  workingDirectory,
  env = process.env,
) {
  const exitCode = await new Promise((resolveExitCode) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArguments], {
      cwd: workingDirectory,
      env,
      stdio: "inherit",
    });
    child.on("error", () => resolveExitCode(1));
    child.on("close", resolveExitCode);
  });
  return exitCode ?? 1;
}

async function runPrebuildInstall(packageDirectory, prebuildArguments) {
  const requireFromPackage = createRequire(
    path.join(packageDirectory, "package.json"),
  );
  const prebuildInstallBinPath = requireFromPackage.resolve(
    "prebuild-install/bin.js",
  );

  const exitCode = await runNodeScript(
    prebuildInstallBinPath,
    prebuildArguments,
    packageDirectory,
  );

  if (exitCode !== 0) {
    throw new Error(
      `prebuild-install for ${BETTER_SQLITE3_PACKAGE_NAME} exited with code ${
        exitCode ?? "null"
      } (arguments: ${prebuildArguments.join(" ")}). The packaged app needs the ` +
        "Electron-ABI binary; refusing to ship a mismatched build.",
    );
  }
}

function resolveNodeGypBinPath() {
  return path.join(
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules"),
    "npm",
    "node_modules",
    "node-gyp",
    "bin",
    "node-gyp.js",
  );
}

async function buildSingleArchBinaryFromSource(
  sourceDirectory,
  destinationPath,
  arch,
  electronVersion,
) {
  const buildDirectory = await mkdtemp(
    path.join(tmpdir(), "bb-better-sqlite3-source-"),
  );
  try {
    await cp(
      path.join(sourceDirectory, "binding.gyp"),
      path.join(buildDirectory, "binding.gyp"),
    );
    await cp(
      path.join(sourceDirectory, "src"),
      path.join(buildDirectory, "src"),
      {
        recursive: true,
      },
    );
    await cp(
      path.join(sourceDirectory, "deps"),
      path.join(buildDirectory, "deps"),
      { recursive: true },
    );
    const nodeGypBinPath = resolveNodeGypBinPath();
    await access(nodeGypBinPath);
    const exitCode = await runNodeScript(
      nodeGypBinPath,
      [
        "rebuild",
        "--release",
        `--target=${electronVersion}`,
        `--arch=${arch}`,
        `--dist-url=${ELECTRON_HEADERS_DIST_URL}`,
      ],
      buildDirectory,
      {
        ...process.env,
        NODE_PATH: path.dirname(sourceDirectory),
      },
    );
    if (exitCode !== 0) {
      throw new Error(
        `node-gyp source build for ${BETTER_SQLITE3_PACKAGE_NAME} exited with code ${exitCode}.`,
      );
    }
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(
      path.join(buildDirectory, BETTER_SQLITE3_NODE_RELATIVE_PATH),
      destinationPath,
    );
    assertLipoArch(destinationPath, arch);
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
}

function lipoArchitectures(filePath) {
  return execFileSync("lipo", ["-info", filePath], { encoding: "utf8" });
}

function assertLipoArch(filePath, arch) {
  const expectedLipoArch = LIPO_ARCH_NAMES[arch];
  if (expectedLipoArch === undefined) {
    return;
  }
  const info = lipoArchitectures(filePath);
  if (!info.includes(expectedLipoArch)) {
    throw new Error(
      `Expected ${expectedLipoArch} in ${filePath}: ${info.trim()}`,
    );
  }
}

async function stagedShippedPrebuild(packageDirectory, arch, platform) {
  const expectedLipoArch = LIPO_ARCH_NAMES[arch];
  if (expectedLipoArch === undefined) {
    return undefined;
  }
  const prebuildPath = path.join(
    packageDirectory,
    "prebuilds",
    `${platform}-${arch}.node`,
  );
  try {
    await access(prebuildPath);
  } catch {
    return undefined;
  }
  try {
    assertLipoArch(prebuildPath, arch);
  } catch {
    return undefined;
  }
  return prebuildPath;
}

async function resolveWorkspaceBetterSqlite3Source() {
  const matches = await findPackageDirectories(
    path.join(repoRoot, NODE_MODULES_DIRECTORY),
    [BETTER_SQLITE3_PACKAGE_NAME],
  );
  for (const candidate of matches.get(BETTER_SQLITE3_PACKAGE_NAME)) {
    try {
      await access(path.join(candidate, "binding.gyp"));
      await access(path.join(candidate, "src"));
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function installSingleArchBinary(packageDirectory, arch, options) {
  const nodeFilePath = path.join(
    packageDirectory,
    BETTER_SQLITE3_NODE_RELATIVE_PATH,
  );
  const shipped = await stagedShippedPrebuild(
    packageDirectory,
    arch,
    options.platform,
  );
  if (shipped !== undefined) {
    await mkdir(path.dirname(nodeFilePath), { recursive: true });
    await copyFile(shipped, nodeFilePath);
    return;
  }
  let downloaded = false;
  try {
    await runPrebuildInstall(
      packageDirectory,
      resolveBetterSqlite3PrebuildArguments({
        arch,
        electronVersion: options.electronVersion,
        platform: options.platform,
      }),
    );
    downloaded = true;
  } catch {
    downloaded = false;
  }
  if (downloaded) {
    try {
      assertLipoArch(nodeFilePath, arch);
      return;
    } catch {
      downloaded = false;
    }
  }
  const sourceDirectory = await resolveWorkspaceBetterSqlite3Source();
  if (sourceDirectory === undefined) {
    throw new Error(
      `Unable to resolve workspace ${BETTER_SQLITE3_PACKAGE_NAME} sources to build ${options.platform}-${arch} from source.`,
    );
  }
  await buildSingleArchBinaryFromSource(
    sourceDirectory,
    nodeFilePath,
    arch,
    options.electronVersion,
  );
}

function verifyBetterSqlite3PackageDirectory(packageDirectory) {
  const electron = createRequire(path.join(desktopPackageRoot, "package.json"))(
    "electron",
  );
  execFileSync(
    electron,
    [
      "-e",
      "const Database = require(process.argv[1]); const db = new Database(':memory:'); if (db.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('SQLite verification failed'); db.close();",
      packageDirectory,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
      timeout: 30_000,
    },
  );
}

function isUniversalMachOBinary(filePath) {
  const info = execFileSync("lipo", ["-info", filePath], { encoding: "utf8" });
  return info.includes("x86_64") && info.includes("arm64");
}

async function prepareUniversalBetterSqlite3PackageDirectory(
  packageDirectory,
  options,
) {
  const nodeFilePath = path.join(
    packageDirectory,
    BETTER_SQLITE3_NODE_RELATIVE_PATH,
  );
  let alreadyUniversal = false;
  try {
    await access(nodeFilePath);
    alreadyUniversal = isUniversalMachOBinary(nodeFilePath);
  } catch {
    alreadyUniversal = false;
  }
  if (!alreadyUniversal) {
    const stagingDirectory = await mkdtemp(
      path.join(tmpdir(), "bb-better-sqlite3-universal-"),
    );
    try {
      const stagedPaths = [];
      for (const arch of MAC_UNIVERSAL_ARCHITECTURES) {
        await installSingleArchBinary(packageDirectory, arch, options);
        const stagedPath = path.join(
          stagingDirectory,
          `better_sqlite3.${arch}.node`,
        );
        await copyFile(nodeFilePath, stagedPath);
        stagedPaths.push(stagedPath);
      }
      execFileSync("lipo", [
        ...stagedPaths,
        "-create",
        "-output",
        nodeFilePath,
      ]);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
  verifyBetterSqlite3PackageDirectory(packageDirectory);
}

async function prepareBetterSqlite3PackageDirectory(packageDirectory, options) {
  if (options.arch === UNIVERSAL_ARCH && options.platform === DARWIN_PLATFORM) {
    await prepareUniversalBetterSqlite3PackageDirectory(
      packageDirectory,
      options,
    );
    return;
  }
  const packageJson = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const supportsLegacyPrebuild =
    typeof packageJson.dependencies?.["prebuild-install"] === "string";
  const canVerify =
    options.platform === process.platform &&
    options.arch === process.arch &&
    options.electronVersion === resolveElectronVersion();
  const verify = () => verifyBetterSqlite3PackageDirectory(packageDirectory);
  if (canVerify) {
    try {
      verify();
      return;
    } catch (error) {
      if (!supportsLegacyPrebuild) throw error;
    }
  } else {
    const shipped = await stagedShippedPrebuild(
      packageDirectory,
      options.arch,
      options.platform,
    );
    if (shipped !== undefined) {
      return;
    }
  }
  try {
    await runPrebuildInstall(
      packageDirectory,
      resolveBetterSqlite3PrebuildArguments(options),
    );
  } catch (error) {
    const needsCrossArchBuild =
      options.arch !== process.arch || options.platform !== process.platform;
    if (!needsCrossArchBuild) throw error;
    const sourceDirectory = await resolveWorkspaceBetterSqlite3Source();
    if (sourceDirectory === undefined) {
      throw error;
    }
    await buildSingleArchBinaryFromSource(
      sourceDirectory,
      path.join(packageDirectory, BETTER_SQLITE3_NODE_RELATIVE_PATH),
      options.arch,
      options.electronVersion,
    );
  }
  if (canVerify) verify();
}

async function preparePackagedNativeModules(appOutDir, options = {}) {
  if (!(await isDirectory(appOutDir))) {
    throw new Error(`Packaged app output does not exist: ${appOutDir}`);
  }

  const packageDirectories = await findPackageDirectories(
    appOutDir,
    PACKAGED_NATIVE_PACKAGE_NAMES,
  );
  const nodePtyDirectories = packageDirectories.get(NODE_PTY_PACKAGE_NAME);
  if (nodePtyDirectories.length === 0) {
    throw new Error(
      `Unable to find ${NODE_PTY_PACKAGE_NAME} under ${appOutDir}`,
    );
  }
  await Promise.all(nodePtyDirectories.map(prepareNodePtyPackageDirectory));

  // The Electron target is only known on the real afterPack path. Standalone
  // invocations (e.g. tests, manual node-pty repair) omit it and skip the fetch.
  if (options.electronVersion === undefined) {
    return { betterSqlite3Directories: [], nodePtyDirectories };
  }

  const betterSqlite3Directories = packageDirectories.get(
    BETTER_SQLITE3_PACKAGE_NAME,
  );
  if (betterSqlite3Directories.length === 0) {
    throw new Error(
      `Unable to find ${BETTER_SQLITE3_PACKAGE_NAME} under ${appOutDir}`,
    );
  }
  await Promise.all(
    betterSqlite3Directories.map((packageDirectory) =>
      prepareBetterSqlite3PackageDirectory(packageDirectory, {
        arch: options.arch,
        electronVersion: options.electronVersion,
        platform: options.platform,
      }),
    ),
  );

  return { betterSqlite3Directories, nodePtyDirectories };
}

function resolveElectronVersion() {
  const requireFromDesktop = createRequire(
    path.join(desktopPackageRoot, "package.json"),
  );
  return requireFromDesktop("electron/package.json").version;
}

function resolveArchName(context) {
  try {
    const { Arch } = require("electron-builder");
    const archName = Arch[context.arch];
    if (typeof archName === "string") {
      return archName;
    }
  } catch {
    // electron-builder is only resolvable inside the build process; fall back to
    // the host architecture, which matches single-arch builds on a native host.
  }
  return process.arch;
}

async function afterPack(context) {
  const arch = resolveArchName(context);
  const platform = context.electronPlatformName ?? process.platform;
  if (platform !== process.platform) {
    throw new Error("Packaged npm verification requires a native target host");
  }
  if (platform !== DARWIN_PLATFORM && arch !== process.arch) {
    throw new Error("Packaged npm verification requires a native target host");
  }
  await preparePackagedNativeModules(context.appOutDir, {
    arch,
    electronVersion: resolveElectronVersion(),
    platform,
  });
  if (arch !== process.arch && arch !== UNIVERSAL_ARCH) {
    return;
  }
  const { smokePackagedNpm } = await import("./smoke-packaged-npm.mjs");
  const productName = context.packager.appInfo.productFilename;
  const appBinary =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${productName}.app`,
          "Contents",
          "MacOS",
          productName,
        )
      : path.join(context.appOutDir, context.packager.executableName);
  await smokePackagedNpm(appBinary);
}

function parseStandaloneArguments(argv) {
  const options = {};
  let appOutDir;

  for (const argument of argv) {
    const electronVersionMatch = argument.match(/^--electron-version=(.+)$/);
    if (electronVersionMatch) {
      options.electronVersion = electronVersionMatch[1];
      continue;
    }
    const archMatch = argument.match(/^--arch=(.+)$/);
    if (archMatch) {
      options.arch = archMatch[1];
      continue;
    }
    const platformMatch = argument.match(/^--platform=(.+)$/);
    if (platformMatch) {
      options.platform = platformMatch[1];
      continue;
    }
    appOutDir = argument;
  }

  if (options.arch === undefined) {
    options.arch = process.arch;
  }
  if (options.platform === undefined) {
    options.platform = process.platform;
  }

  return { appOutDir, options };
}

async function main() {
  const { appOutDir, options } = parseStandaloneArguments(
    process.argv.slice(2),
  );
  if (appOutDir === undefined || appOutDir.length === 0) {
    throw new Error(
      "Usage: node apps/desktop/scripts/prepare-native-modules.cjs <appOutDir> " +
        "[--electron-version=<version>] [--arch=<arch>] [--platform=<platform>]",
    );
  }

  await preparePackagedNativeModules(path.resolve(appOutDir), options);
}

module.exports = afterPack;
module.exports.parseStandaloneArguments = parseStandaloneArguments;
module.exports.resolveBetterSqlite3PrebuildArguments =
  resolveBetterSqlite3PrebuildArguments;
module.exports.isUniversalMachOBinary = isUniversalMachOBinary;

if (require.main === module) {
  main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
