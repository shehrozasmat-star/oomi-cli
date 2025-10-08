#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import extract from 'extract-zip';
import { execSync } from 'child_process';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { validateLicense } from './utils/auth.js';

const program = new Command();

program
  .name('oomi')
  .description('Create WordPress projects from the official GitHub repository')
  .version('1.0.0');

program
  .command('create-project')
  .option('--name <projectName>', 'Project name (if omitted, you will be prompted)')
  .option('--theme <git_repo_url>', 'Optional theme git repository URL')
  .action(async (opts) => {
    const { valid, message } = validateLicense();
    if (!valid) {
      console.error(`Error: ${message}`);
      process.exit(1);
    }

    
    const AVAILABLE_THEMES = [
      { name: 'oomi-boilerplate-theme', url: 'https://github.com/shehrozasmat-star/oomi-boilerplate-theme' }
    ];
    const AVAILABLE_PLUGINS = [
      { name: 'oomi-sso', url: 'https://github.com/shehrozasmat-star/oomi-sso' },
      { name: 'oomi-listing', url: 'https://github.com/shehrozasmat-star/oomi-listing' }
    ];

    let projectName = String(opts.name || '').trim();
    const answers = await inquirer.prompt([
      ...(projectName ? [] : [{
        type: 'input',
        name: 'projectName',
        message: 'Enter project name:',
        validate: (v) => {
          const name = String(v || '').trim();
          if (!name) return 'Project name is required';
          if (/[\\/:*?"<>|]/.test(name)) return 'Project name cannot contain path separators or special characters';
          return true;
        }
      }]),
      {
        type: 'confirm',
        name: 'injectTheme',
        message: 'Do you want to inject the theme?',
        default: true
      },
      {
        type: 'checkbox',
        name: 'selectedThemes',
        message: 'Select theme(s) to include (space to toggle, enter to confirm):',
        when: (a) => a.injectTheme,
        choices: AVAILABLE_THEMES.map(t => ({ name: t.name, value: t.url }))
      },
      {
        type: 'checkbox',
        name: 'selectedPlugins',
        message: 'Select plugin(s) to include (space to toggle, enter to confirm):',
        choices: AVAILABLE_PLUGINS.map(p => ({ name: p.name, value: p.url }))
      },
      {
        type: 'confirm',
        name: 'includeGitignore',
        message: 'Do you want to include .gitignore in WordPress installation?',
        default: true
      }
    ]);

    if (!projectName) projectName = String(answers.projectName || '').trim();

    // Preselect theme passed via --theme as well
    const selectedThemeUrls = new Set([...(answers.selectedThemes || [])]);
    if (opts.theme) selectedThemeUrls.add(String(opts.theme).trim());
    const selectedPluginUrls = new Set([...(answers.selectedPlugins || [])]);

    // Prompt for custom theme folder names per selected theme
    const themeSelections = [];
    if (selectedThemeUrls.size > 0) {
      const usedNames = new Set();
      for (const url of selectedThemeUrls) {
        const defaultName = deriveRepoName(url);
        let promptDefault = defaultName;
        // Ensure default doesn't collide with already chosen names in this prompt loop
        let suffix = 1;
        while (usedNames.has(promptDefault)) {
          promptDefault = `${defaultName}-${suffix++}`;
        }
        const { themeName } = await inquirer.prompt([{
          type: 'input',
          name: 'themeName',
          message: `Set folder name for theme (${defaultName}):`,
          default: promptDefault,
          validate: (v) => {
            const name = String(v || '').trim();
            if (!name) return 'Theme folder name is required';
            if (/[\\\/:*?"<>|]/.test(name)) return 'Name cannot contain path separators or special characters';
            if (usedNames.has(name)) return 'Each theme must have a unique folder name';
            return true;
          }
        }]);
        const finalName = String(themeName || '').trim();
        usedNames.add(finalName);
        themeSelections.push({ url, name: finalName });
      }
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

      // Clone selected themes
      if ((themeSelections && themeSelections.length > 0) || selectedThemeUrls.size > 0) {
        const themesDir = path.join(projectDir, 'wp-content', 'themes');
        await fsp.mkdir(themesDir, { recursive: true });
        const list = (themeSelections && themeSelections.length > 0)
          ? themeSelections
          : Array.from(selectedThemeUrls).map(url => ({ url, name: deriveRepoName(url) }));
        for (const { url: themeUrl, name: themeName } of list) {
          const themeDest = path.join(themesDir, themeName);
          if (fs.existsSync(themeDest)) {
            console.warn(`Skipping theme (already exists): ${themeDest}`);
            continue;
          }
          console.log(`Cloning theme into ${path.relative(process.cwd(), themeDest)} ...`);
          execSync(`git clone --depth 1 "${themeUrl}" "${themeDest}"`, { stdio: 'inherit' });
        }
      }

      // Clone selected plugins
      if (selectedPluginUrls.size > 0) {
        const pluginsDir = path.join(projectDir, 'wp-content', 'plugins');
        await fsp.mkdir(pluginsDir, { recursive: true });
        for (const pluginUrl of selectedPluginUrls) {
          const pluginName = deriveRepoName(pluginUrl);
          const pluginDest = path.join(pluginsDir, pluginName);
          if (fs.existsSync(pluginDest)) {
            console.warn(`Skipping plugin (already exists): ${pluginDest}`);
            continue;
          }
          console.log(`Cloning plugin into ${path.relative(process.cwd(), pluginDest)} ...`);
          execSync(`git clone --depth 1 "${pluginUrl}" "${pluginDest}"`, { stdio: 'inherit' });
        }
      }

      // Create .gitignore if requested
      if (answers.includeGitignore) {
        const selectedThemeNames = (themeSelections && themeSelections.length > 0)
          ? themeSelections.map(t => t.name)
          : Array.from(selectedThemeUrls).map(deriveRepoName);
        const selectedPluginNames = Array.from(selectedPluginUrls).map(deriveRepoName);
        const giContent = generateWordPressGitignore(selectedThemeNames, selectedPluginNames);
        await fsp.writeFile(path.join(projectDir, '.gitignore'), giContent, 'utf8');
        console.log('Created .gitignore tailored to selected themes/plugins.');
      }

      console.log('Success: WordPress project created.');
      console.log(`Location: ${projectDir}`);
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


function generateWordPressGitignore(themeNames = [], pluginNames = []) {
  const lines = [];
  lines.push('# WordPress project: ignore everything except selected themes/plugins');
  lines.push('/*');
  lines.push('!.gitignore');
  lines.push('!wp-content/');
  lines.push('');
  lines.push('# In wp-content, ignore all except themes and plugins');
  lines.push('wp-content/*');
  lines.push('!wp-content/themes/');
  lines.push('!wp-content/plugins/');
  lines.push('');
  lines.push('# Ignore all themes except the selected ones');
  lines.push('wp-content/themes/*');
  for (const name of themeNames) {
    const n = String(name).trim();
    if (!n) continue;
    lines.push(`!wp-content/themes/${n}/**`);
  }
  lines.push('');
  lines.push('# Ignore all plugins except the selected ones');
  lines.push('wp-content/plugins/*');
  for (const name of pluginNames) {
    const n = String(name).trim();
    if (!n) continue;
    lines.push(`!wp-content/plugins/${n}/**`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}
