import * as os from "os";
import * as path from "path";

import * as asar from "asar";
import * as diff from "diff";
import * as fs from "fs-extra";
import natsort from "natsort";

import {baseDir} from "../global";
import {CURRENT_PLATFORM, Platforms} from "./platform";

/**
 * Custom asar extraction that handles missing unpacked files gracefully
 */
function extractAsarWithUnpacked(asarFile: string, destDir: string): void {
  const unpackedDir = asarFile + ".unpacked";

  // Pre-copy the unpacked directory if it exists (before extraction)
  if (fs.existsSync(unpackedDir)) {
    copyUnpackedFiles(unpackedDir, destDir);
  }

  // Try extractAll, if it fails due to missing unpacked files, fall back to manual extraction
  try {
    asar.extractAll(asarFile, destDir);
  } catch (e) {
    const err = e as any;
    // If error is about missing unpacked file, use manual extraction
    if (err.code === "ENOENT" && err.path && err.path.includes(".unpacked")) {
      console.warn(
        "Warning: Some unpacked files are missing, using fallback extraction...",
      );
      extractAsarManually(asarFile, destDir, unpackedDir);
    } else {
      throw e;
    }
  }
}

/**
 * Get the asar header to check file metadata
 */
function getAsarHeader(asarFile: string): any {
  const disk = require("asar/lib/disk");
  return disk.readArchiveHeaderSync(asarFile).header;
}

/**
 * Check if a path in the asar is a directory or file
 * Returns: { isDir: boolean, isUnpacked: boolean, exists: boolean }
 */
function getAsarEntryInfo(
  header: any,
  filePath: string,
): {isDir: boolean; isUnpacked: boolean; exists: boolean} {
  const parts = filePath.split(/[\\\/]/).filter((p) => p);
  let node = header;

  for (const part of parts) {
    if (!node.files || !node.files[part]) {
      return {isDir: false, isUnpacked: false, exists: false};
    }
    node = node.files[part];
  }

  const isDir = "files" in node;
  const isUnpacked = node.unpacked === true;
  return {isDir, isUnpacked, exists: true};
}

/**
 * Manual asar extraction that skips missing unpacked files
 */
function extractAsarManually(
  asarFile: string,
  destDir: string,
  unpackedDir: string,
): void {
  const filenames: string[] = (asar as any).listPackage(asarFile);
  const header = getAsarHeader(asarFile);

  for (const filename of filenames) {
    // Normalize path - remove leading slashes
    const normalizedFilename = filename.replace(/^[\\\/]+/, "");
    const destFilename = path.join(destDir, normalizedFilename);

    // Get entry info from header
    const entryInfo = getAsarEntryInfo(header, normalizedFilename);

    // If it's a directory, just ensure it exists and continue
    if (entryInfo.isDir) {
      if (!fs.existsSync(destFilename)) {
        fs.ensureDirSync(destFilename);
      }
      continue;
    }

    // If file already exists as a proper file, skip
    if (fs.existsSync(destFilename)) {
      const stat = fs.statSync(destFilename);
      if (stat.isFile()) {
        continue;
      }
      // If it's a directory but should be a file, remove it
      if (stat.isDirectory()) {
        fs.removeSync(destFilename);
      }
    }

    // If it's an unpacked file, it should have been copied already
    // If missing from unpacked dir, skip it
    if (entryInfo.isUnpacked) {
      console.warn(
        `Warning: Skipping missing unpacked file: ${normalizedFilename}`,
      );
      continue;
    }

    try {
      // Extract regular (non-unpacked) file
      const file = (asar as any).extractFile(asarFile, normalizedFilename);
      if (file !== undefined && Buffer.isBuffer(file)) {
        fs.ensureDirSync(path.dirname(destFilename));
        fs.writeFileSync(destFilename, file);
      }
    } catch (e) {
      const err = e as any;
      // Skip any remaining errors gracefully
      console.warn(
        `Warning: Failed to extract ${normalizedFilename}: ${err.message}`,
      );
      continue;
    }
  }
}

/**
 * Recursively copy unpacked files to destination
 */
function copyUnpackedFiles(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) {
    return;
  }

  const items = fs.readdirSync(srcDir);
  for (const item of items) {
    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);

    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.ensureDirSync(destPath);
        copyUnpackedFiles(srcPath, destPath);
      } else {
        fs.ensureDirSync(path.dirname(destPath));
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      // Skip files that can't be accessed (might be symlinks or permission issues)
      const err = e as any;
      if (
        err.code === "ENOENT" ||
        err.code === "EPERM" ||
        err.code === "EACCES"
      ) {
        console.warn(`Warning: Skipping inaccessible file: ${srcPath}`);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Patcher options
 */
export interface IPatcherOptions {
  /**
   * app.asar file
   */
  readonly asar?: string;

  /**
   * app directory
   */
  readonly dir?: string;

  /**
   * Patcher features
   */
  readonly features: string[];
}

/**
 * Patcher
 */
export class Patcher {
  private static findAsarUnix(...files: string[]): string | undefined {
    return files.find((file) => fs.existsSync(file));
  }

  private static findAsarLinux(): string | undefined {
    return Patcher.findAsarUnix(
      "/opt/gitkraken/resources/app.asar", // Arch Linux
      "/usr/share/gitkraken/resources/app.asar", // deb & rpm
    );
  }

  private static findAsarWindows(): string | undefined {
    const gitkrakenLocal = path.join(os.homedir(), "AppData/Local/gitkraken");
    if (!fs.existsSync(gitkrakenLocal)) {
      return undefined;
    }
    const apps = fs
      .readdirSync(gitkrakenLocal)
      .filter((item) => item.match(/^app-\d+\.\d+\.\d+$/));
    let app = apps.sort(natsort({desc: true}))[0];
    if (!app) {
      return undefined;
    }
    app = path.join(gitkrakenLocal, app, "resources/app.asar");
    return fs.existsSync(app) ? app : undefined;
  }

  private static findAsarMacOS(): string | undefined {
    return Patcher.findAsarUnix(
      "/Applications/GitKraken.app/Contents/Resources/app.asar",
    );
  }

  private static findAsar(dir?: string): string | undefined {
    if (dir) {
      return path.normalize(dir) + ".asar";
    }
    switch (CURRENT_PLATFORM) {
      case Platforms.linux:
        return Patcher.findAsarLinux();
      case Platforms.windows:
        return Patcher.findAsarWindows();
      case Platforms.macOS:
        return Patcher.findAsarMacOS();
    }
  }

  private static findDir(asarFile: string): string {
    return path.join(
      path.dirname(asarFile),
      path.basename(asarFile, path.extname(asarFile)),
    );
  }

  private readonly _asar: string;
  private readonly _dir: string;
  private readonly _features: string[];

  /**
   * Patcher constructor
   * @param options Options
   */
  public constructor(options: IPatcherOptions) {
    const maybeAsar = options.asar || Patcher.findAsar(options.dir);
    if (!maybeAsar) {
      throw new Error("Can't find app.asar!");
    }
    this._asar = maybeAsar;
    this._dir = options.dir || Patcher.findDir(this.asar);
    this._features = options.features;
    if (!this.features.length) {
      throw new Error("Features is empty!");
    }
  }

  /**
   * app.asar file
   */
  public get asar(): string {
    return this._asar;
  }

  /**
   * app directory
   */
  public get dir(): string {
    return this._dir;
  }

  /**
   * Patcher features
   */
  public get features(): string[] {
    return this._features;
  }

  /**
   * Backup app.asar file
   * @throws Error
   */
  public backupAsar(): string {
    const backup = `${this.asar}.${new Date().getTime()}.backup`;
    fs.copySync(this.asar, backup);
    return backup;
  }

  /**
   * Unpack app.asar file into app directory
   * @throws Error
   */
  public unpackAsar(): void {
    extractAsarWithUnpacked(this.asar, this.dir);
  }

  /**
   * Pack app directory to app.asar file
   * @throws Error
   */
  public packDirAsync(): Promise<void> {
    return asar.createPackage(this.dir, this.asar);
  }

  /**
   * Remove app directory
   * @throws Error
   */
  public removeDir(): void {
    fs.removeSync(this.dir);
  }

  /**
   * Patch app directory
   * @throws Error
   */
  public patchDir(): void {
    for (const feature of this.features) {
      switch (feature) {
        case "pro":
          this.patchDirWithPro();
          break;

        default:
          this.patchDirWithFeature(feature);
          break;
      }
    }
  }

  private patchDirWithPro(): void {
    const bundlePath = path.join(this.dir, "src/main/static/main.bundle.js");

    const patchedPattern =
      '(delete json.proAccessState,delete json.licenseExpiresAt,json={...json,licensedFeatures:["pro"]});';

    const pattern1 = /const [^=]*="dev"===[^?]*\?"[\w+/=]+":"[\w+/=]+";/;
    const pattern2 = /return (JSON\.parse\(\([^;]*?\)\(Buffer\.from\([^;]*?,"base64"\)\.toString\("utf8"\),Buffer\.from\([^;]*?\.secure,"base64"\)\)\.toString\("utf8"\)\))\};/;
    const searchValue = new RegExp(`(?<=${pattern1.source})${pattern2.source}`);
    const replaceValue =
      "var json=$1;" +
      '("licenseExpiresAt"in json||"licensedFeatures"in json)&&' +
      '(delete json.proAccessState,delete json.licenseExpiresAt,json={...json,licensedFeatures:["pro"]});' +
      "return json};";

    const sourceData = fs.readFileSync(bundlePath, "utf-8");
    const sourcePatchedData = sourceData.replace(searchValue, replaceValue);
    if (sourceData === sourcePatchedData) {
      if (sourceData.indexOf(patchedPattern) < 0)
        throw new Error(
          "Can't patch pro features, pattern match failed. Get support from https://t.me/gitkrakencrackchat",
        );
      throw new Error("It's already patched.");
    }
    fs.writeFileSync(bundlePath, sourcePatchedData, "utf-8");
  }

  private patchDirWithFeature(feature: string): void {
    const patches = diff.parsePatch(
      fs.readFileSync(path.join(baseDir, "patches", `${feature}.diff`), "utf8"),
    );
    for (const patch of patches) {
      this.patchDirWithPatch(patch);
    }
  }

  private patchDirWithPatch(patch: diff.ParsedDiff): void {
    const sourceData = fs.readFileSync(
      path.join(this.dir, patch.oldFileName!),
      "utf8",
    );
    const sourcePatchedData = diff.applyPatch(sourceData, patch);
    if ((sourcePatchedData as any) === false) {
      throw new Error(`Can't patch ${patch.oldFileName}`);
    }
    if (patch.oldFileName !== patch.newFileName) {
      fs.unlinkSync(path.join(this.dir, patch.oldFileName!));
    }
    fs.writeFileSync(
      path.join(this.dir, patch.newFileName!),
      sourcePatchedData,
      "utf8",
    );
  }
}
