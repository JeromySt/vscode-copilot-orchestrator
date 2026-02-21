/**
 * @fileoverview Default IFileSystem implementation using Node.js fs module.
 * 
 * Production implementation of the file system abstraction.
 * All file I/O in the extension should go through this interface for testability.
 * 
 * @module core/defaultFileSystem
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IFileSystem } from '../interfaces/IFileSystem';

/**
 * Default file system implementation backed by Node.js fs module.
 */
export class DefaultFileSystem implements IFileSystem {
  // ─── Sync Operations ───────────────────────────────────────────────────

  ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  readJSON<T>(filePath: string, fallback: T): T {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  writeJSON(filePath: string, obj: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  // ─── Async Operations ─────────────────────────────────────────────────

  async ensureDirAsync(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async readJSONAsync<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  async writeJSONAsync(filePath: string, obj: any): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  async existsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Low-Level File Operations ─────────────────────────────────────────

  existsSync(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  async readFileAsync(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  readFileSync(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  async writeFileAsync(filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  writeFileSync(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  async renameAsync(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.rename(oldPath, newPath);
  }

  renameSync(oldPath: string, newPath: string): void {
    fs.renameSync(oldPath, newPath);
  }

  async unlinkAsync(filePath: string): Promise<void> {
    await fs.promises.unlink(filePath);
  }

  unlinkSync(filePath: string): void {
    fs.unlinkSync(filePath);
  }

  async rmAsync(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fs.promises.rm(filePath, options);
  }

  async rmdirAsync(dirPath: string): Promise<void> {
    await fs.promises.rmdir(dirPath);
  }

  async mkdirAsync(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.promises.mkdir(dirPath, options);
  }

  mkdirSync(dirPath: string, options?: { recursive?: boolean }): void {
    fs.mkdirSync(dirPath, options);
  }

  async readdirAsync(dirPath: string): Promise<string[]> {
    return fs.promises.readdir(dirPath) as Promise<string[]>;
  }

  async lstatAsync(filePath: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }> {
    return fs.promises.lstat(filePath);
  }

  async symlinkAsync(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): Promise<void> {
    await fs.promises.symlink(target, linkPath, type);
  }

  async readlinkAsync(linkPath: string): Promise<string> {
    return fs.promises.readlink(linkPath);
  }

  async accessAsync(filePath: string): Promise<void> {
    await fs.promises.access(filePath);
  }

  async copyFileAsync(src: string, dest: string): Promise<void> {
    await fs.promises.copyFile(src, dest);
  }
}
