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

    // Prompt for theme display names and compute folder slugs per selected theme
    const themeSelections = [];
    if (selectedThemeUrls.size > 0) {
      const usedSlugs = new Set();
      for (const url of selectedThemeUrls) {
        const defaultRepoName = deriveRepoName(url);
        const baseTitle = toTitleFromSlug(defaultRepoName);
        let promptDefault = baseTitle;
        // Ensure default slug doesn't collide with already chosen slugs
        let suffix = 1;
        while (usedSlugs.has(slugify(promptDefault))) {
          promptDefault = `${baseTitle} ${suffix++}`;
        }
        const { themeName } = await inquirer.prompt([{
          type: 'input',
          name: 'themeName',
          message: `Set theme name (shown in WordPress) for (${defaultRepoName}):`,
          default: promptDefault,
          validate: (v) => {
            const name = String(v || '').trim();
            if (!name) return 'Theme name is required';
            if (/[\\\/:*?"<>|]/.test(name)) return 'Name cannot contain path separators or special characters';
            const slug = slugify(name);
            if (!slug) return 'Resulting folder name is empty; choose another name';
            if (usedSlugs.has(slug)) return 'Each theme must have a unique name (slug would collide)';
            return true;
          }
        }]);
        const displayName = String(themeName || '').trim();
        const dirSlug = slugify(displayName);
        usedSlugs.add(dirSlug);
        themeSelections.push({ url, name: dirSlug, displayName });
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
          : Array.from(selectedThemeUrls).map(url => {
              const name = deriveRepoName(url);
              return { url, name, displayName: toTitleFromSlug(name) };
            });
        for (const { url: themeUrl, name: themeName, displayName } of list) {
          const themeDest = path.join(themesDir, themeName);
          if (fs.existsSync(themeDest)) {
            console.warn(`Skipping theme (already exists): ${themeDest}`);
            // Try to apply display name even if existing
            try {
              if (displayName) await applyThemeMeta(themeDest, displayName, themeName);
            } catch (_) { /* ignore */ }
            continue;
          }
          console.log(`Cloning theme into ${path.relative(process.cwd(), themeDest)} ...`);
          execSync(`git clone --depth 1 "${themeUrl}" "${themeDest}"`, { stdio: 'inherit' });
          try {
            if (displayName) await applyThemeMeta(themeDest, displayName, themeName);
          } catch (e) {
            console.warn(`Warning: Failed to apply theme display name for ${themeName}: ${e?.message || e}`);
          }
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


// Helper: convert a human-readable name to a safe folder slug (kebab-case)
function slugify(str) {
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Helper: convert slug or repo name to Title Case for display
function toTitleFromSlug(str) {
  return String(str)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

// After cloning a theme, ensure its style.css shows the chosen Theme Name and Text Domain
async function applyThemeMeta(themeDir, displayName, slug) {
  try {
    const stylePath = path.join(themeDir, 'style.css');
    if (!fs.existsSync(stylePath)) {
      console.warn(`Warning: style.css not found in ${path.basename(themeDir)}; cannot set Theme Name.`);
      return;
    }
    const raw = await fsp.readFile(stylePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    let changed = false;
    let nameReplaced = false;

    // Replace Theme Name line within the first 200 lines
    for (let i = 0; i < Math.min(lines.length, 200); i++) {
      const m = lines[i].match(/^(\s*\*?\s*)Theme\s*Name\s*:\s*(.*)$/i);
      if (m) {
        lines[i] = `${m[1]}Theme Name: ${displayName}`;
        nameReplaced = true;
        changed = true;
        break;
      }
      // Stop if header likely ended
      if (/^\s*\*\/\s*$/.test(lines[i])) break;
    }

    // Replace or insert Text Domain to match slug
    let domainReplaced = false;
    if (slug) {
      for (let i = 0; i < Math.min(lines.length, 200); i++) {
        const m = lines[i].match(/^(\s*\*?\s*)Text\s*Domain\s*:\s*(.*)$/i);
        if (m) {
          lines[i] = `${m[1]}Text Domain: ${slug}`;
          domainReplaced = true;
          changed = true;
          break;
        }
        if (/^\s*\*\/\s*$/.test(lines[i])) break;
      }
      if (!domainReplaced && nameReplaced) {
        // Insert just after Theme Name line
        const idx = lines.findIndex(l => /^\s*\*?\s*Theme\s*Name\s*:/i.test(l));
        const prefixMatch = idx >= 0 ? lines[idx].match(/^(\s*\*?\s*)/) : null;
        const prefix = prefixMatch ? prefixMatch[1] : '';
        if (idx >= 0) {
          lines.splice(idx + 1, 0, `${prefix}Text Domain: ${slug}`);
          changed = true;
        }
      }
    }

    if (changed) {
      await fsp.writeFile(stylePath, lines.join('\n'), 'utf8');
      return;
    }

    // If no header fields were found, prepend a minimal header
    const header = [
      '/*',
      `Theme Name: ${displayName}`,
      ...(slug ? [`Text Domain: ${slug}`] : []),
      '*/',
      ''
    ].join('\n');
    await fsp.writeFile(stylePath, header + raw, 'utf8');
  } catch (e) {
    console.warn(`Warning: Could not update theme metadata in ${path.basename(themeDir)}: ${e?.message || e}`);
  }
}
