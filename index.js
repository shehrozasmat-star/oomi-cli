#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import extract from 'extract-zip';
import { execSync } from 'child_process';
import { Command } from 'commander';
import { validateLicense } from './utils/auth.js';

const program = new Command();

program
  .name('oomi')
  .description('Create WordPress projects from the official GitHub repository')
  .version('1.0.0');

program
  .command('create-project')
  .requiredOption('--name <projectName>', 'Project name')
  .option('--theme <git_repo_url>', 'Optional theme git repository URL')
  .action(async (opts) => {
    const { valid, message } = validateLicense();
    if (!valid) {
      console.error(`Error: ${message}`);
      process.exit(1);
    }

    const projectName = String(opts.name || '').trim();
    if (!projectName) {
      console.error('Error: --name is required.');
      process.exit(1);
    }

    const projectDir = path.resolve(process.cwd(), projectName);
    if (fs.existsSync(projectDir)) {
      console.error(`Error: Folder already exists: ${projectDir}`);
      process.exit(1);
    }

    let tmpBase = null;
    try {
      console.log(`Creating project folder: ${projectDir}`);
      await fsp.mkdir(projectDir);

      tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'oomi-'));
      const zipPath = path.join(tmpBase, 'wordpress.zip');
      const extractDir = path.join(tmpBase, 'extracted');
      await fsp.mkdir(extractDir);

      console.log('Fetching latest WordPress release info from GitHub ...');
      let release;
      try {
        const resp = await axios.get('https://api.github.com/repos/WordPress/WordPress/releases/latest', {
          headers: {
            'User-Agent': 'oomi-cli',
            'Accept': 'application/vnd.github+json'
          },
          timeout: 30000
        });
        release = resp.data;
      } catch (err) {
        console.warn('Warning: Failed to fetch latest release info, falling back to default zipball.');
      }

      const zipUrl = (release && release.zipball_url) ? release.zipball_url : 'https://api.github.com/repos/WordPress/WordPress/zipball';

      console.log('Downloading WordPress source ...');
      await downloadToFile(zipUrl, zipPath, {
        headers: { 'User-Agent': 'oomi-cli', 'Accept': 'application/vnd.github+json' },
        timeout: 120000
      });

      console.log('Extracting archive ...');
      await extract(zipPath, { dir: extractDir });

      const entries = await fsp.readdir(extractDir, { withFileTypes: true });
      const topDir = entries.find(e => e.isDirectory());
      if (!topDir) throw new Error('Unexpected archive structure: no top-level directory found inside the ZIP.');
      const topDirPath = path.join(extractDir, topDir.name);

      console.log('Copying files into project folder ...');
      await copyDirContents(topDirPath, projectDir);

      if (opts.theme) {
        const themeUrl = String(opts.theme).trim();
        const themesDir = path.join(projectDir, 'wp-content', 'themes');
        await fsp.mkdir(themesDir, { recursive: true });
        const themeName = deriveRepoName(themeUrl);
        const themeDest = path.join(themesDir, themeName);
        if (fs.existsSync(themeDest)) {
          throw new Error(`Theme destination already exists: ${themeDest}`);
        }
        console.log(`Cloning theme into ${path.relative(process.cwd(), themeDest)} ...`);
        execSync(`git clone --depth 1 "${themeUrl}" "${themeDest}"`, { stdio: 'inherit' });
      }

      console.log('Success: WordPress project created.');
      console.log(`Location: ${projectDir}`);
      if (opts.theme) {
        console.log('Theme installed successfully.');
      }
    } catch (err) {
      console.error(`Error: ${err?.message || String(err)}`);
      // Cleanup project directory on failure
      try {
        if (fs.existsSync(projectDir)) {
          await fsp.rm(projectDir, { recursive: true, force: true });
        }
      } catch (_) { /* ignore */ }
    } finally {
      // Cleanup temp files
      try {
        if (tmpBase) await fsp.rm(tmpBase, { recursive: true, force: true });
      } catch (_) { /* ignore */ }
    }
  });

program.parseAsync(process.argv);

async function downloadToFile(url, destPath, axiosOptions = {}) {
  const response = await axios.get(url, { ...axiosOptions, responseType: 'stream', maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    let finished = false;
    const cleanup = (err) => {
      if (!finished) {
        finished = true;
        writer.close(() => err ? reject(err) : resolve());
      }
    };
    writer.on('finish', cleanup);
    writer.on('error', cleanup);
    response.data.on('error', cleanup);
  });
}

async function copyDirContents(srcDir, destDir) {
  // Node 16+ supports fs.cp
  if (fsp.cp) {
    await fsp.cp(srcDir, destDir, { recursive: true });
    return;
  }
  await ensureDir(destDir);
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(srcPath);
      await fsp.symlink(link, destPath);
    } else {
      await ensureDir(path.dirname(destPath));
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function deriveRepoName(repoUrl) {
  // Handle https, ssh, and git URLs
  let name = repoUrl.trim();
  // Strip trailing slashes
  name = name.replace(/\/+$/, '');
  // If ssh style: git@github.com:user/repo.git
  const sshMatch = name.match(/([^\/:]+)\.git$/);
  if (sshMatch) return sshMatch[1];
  // Else split by '/'
  const parts = name.split('/');
  const last = parts[parts.length - 1] || '';
  return last.replace(/\.git$/, '') || 'theme';
}
