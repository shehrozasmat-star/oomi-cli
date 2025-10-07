# OOMI CLI — WordPress Project Creator

Create new WordPress projects directly from the official WordPress GitHub repository — without wp-cli.

This CLI downloads the latest WordPress source ZIP from GitHub, extracts it into a new folder, and (optionally) clones a theme into `wp-content/themes`.

## Requirements
- Node.js >= 18
- Git (required if you use the `--theme` option)
- Internet access to github.com

## Install (local dev)
1) Clone or download this repository
2) Install dependencies
```bash
npm install
```
3) Link the CLI globally so you can run `oomi` from anywhere
```bash
npm link
```

To update later after pulling changes:
```bash
git pull
npm link
```

To uninstall the global link:
```bash
npm unlink -g oomi
```

## License key (required)
OOMI requires a valid license key before running any command. Two ways to provide it:

- Environment variable `OOMI_KEY` (recommended)
- A `.oomi-license` file in your current working directory (the folder where you run `oomi`) containing just the key value

Valid keys are managed in `utils/auth.js` (example keys):
```
["OOMI-123-ABC", "OOMI-456-XYZ"]
```

Examples:
- macOS/Linux
```bash
export OOMI_KEY=OOMI-123-ABC
```
- Windows PowerShell
```powershell
$env:OOMI_KEY = "OOMI-123-ABC"
```
- Using a file (any OS): create a text file named `.oomi-license` containing the key in the directory where you will run `oomi`.

If the key is invalid or missing, the CLI will exit with an error.

## Usage
Command:
```
oomi create-project --name <projectName> [--theme <git_repo_url>]
```

What it does:
1. Validates your license key
2. Creates a new folder using the project name
3. Downloads the latest WordPress release ZIP from the official WordPress GitHub repository
4. Extracts it into the created folder
5. Optionally clones a theme into `wp-content/themes/<themeName>` if `--theme` is provided

### Examples
- Create a project named `portal`:
```bash
export OOMI_KEY=OOMI-123-ABC   # or set via PowerShell: $env:OOMI_KEY="OOMI-123-ABC"
oomi create-project --name portal
```

- Create a project and install a theme from a Git repo URL:
```bash
export OOMI_KEY=OOMI-123-ABC
oomi create-project --name portal --theme https://github.com/yourname/yourtheme.git
```
The theme will be placed into:
```
portal/wp-content/themes/yourtheme
```

### Options
- `--name <projectName>` (required): The folder to create and populate with WordPress
- `--theme <git_repo_url>` (optional): A Git URL to clone into `wp-content/themes/<repoName>`

## Messages and behavior
- If the destination folder already exists, the command exits with an error and does not overwrite it.
- If download or extraction fails, the CLI cleans up temporary files (and the project folder) and exits with an error.
- Progress and helpful messages are printed throughout.

## Troubleshooting
- GitHub API rate limits: The CLI fetches release info via the GitHub API and falls back to a default zipball URL if the API call fails. If your network blocks GitHub or you hit rate limits, try again later or ensure proxy settings allow access to github.com.
- Windows PowerShell: If environment variables do not appear to be set, confirm the shell session where you set `$env:OOMI_KEY` is the same one where you run `oomi`.
- Permission issues when creating folders: Run your terminal with appropriate permissions or choose a directory where your user can write files.

## Project structure
```
.
├── index.js          # CLI entry point (has the shebang `#!/usr/bin/env node`)
├── package.json      # CLI configuration with "bin": { "oomi": "./index.js" }
└── utils/
    └── auth.js       # License validation logic
```

## Development notes
- The CLI is built with Commander, Axios, and extract-zip.
- Theme cloning uses `git clone --depth 1`.
- The package is marked as `"private": true` to avoid accidental publishing to npm.

## License
This project is UNLICENSED for distribution; usage is restricted by license key validation.

## Team installation via npm install
You can share this CLI with your teammates without publishing it to the public npm registry. Choose one of these approaches:

1) Install directly from a Git repository
- HTTPS (read-only):
  - Global
    - macOS/Linux:
      - npm install -g https://github.com/your-org/oomi-cli.git
    - Windows PowerShell:
      - npm install -g https://github.com/your-org/oomi-cli.git
  - Local to a project (adds to dependencies):
    - npm install https://github.com/your-org/oomi-cli.git --save-dev
- SSH (requires repo access and SSH keys configured):
  - npm install -g git+ssh://git@github.com:your-org/oomi-cli.git
- Pin to a tag/branch/commit:
  - npm install -g https://github.com/your-org/oomi-cli.git#v1.0.0
  - npm install -g https://github.com/your-org/oomi-cli.git#main

Notes:
- Replace your-org/oomi-cli with your actual repository path.
- The package has a proper bin mapping ("oomi": "./index.js"), so after a global install the "oomi" command will be available on PATH.
- "private": true blocks publishing to the public npm registry, but npm install from a Git URL still works fine for teams.

2) Install from a tarball (.tgz) produced by npm pack
- Maintainer runs in the repo root:
  - npm ci
  - npm pack
  - This produces something like oomi-cli-1.0.0.tgz. Share that file with your team (email, SharePoint, network drive, etc.).
- Teammate installs:
  - Global
    - npm install -g C:\path\to\oomi-cli-1.0.0.tgz
  - Local (project devDependency):
    - npm install C:\path\to\oomi-cli-1.0.0.tgz --save-dev

3) Install directly from a shared folder path
- If the repository is on a shared drive your teammates can access:
  - Global:
    - npm install -g C:\shared\tools\oomi-cli
  - Local dependency:
    - npm install C:\shared\tools\oomi-cli --save-dev

4) Using a private npm registry (optional)
- If your organization uses a private npm registry (e.g., Verdaccio, GitHub Packages, Nexus):
  - Keep this package private to the public registry, but publish to your internal registry.
  - Configure .npmrc with your registry URL and auth.
  - Then teammates can run npm install -g oomi-cli or add it as a dependency from that registry.

License key reminder (required)
- Every teammate must provide a valid license key before using the CLI.
- Options:
  - Environment variable OOMI_KEY
    - PowerShell: $env:OOMI_KEY = "<YOUR_KEY>"
    - Bash/zsh: export OOMI_KEY=<YOUR_KEY>
  - OR a .oomi-license file in the working directory containing the key.

Update and uninstall
- Update (Git URL install): re-run the npm install command pointing at the newer tag/commit.
- Update (tarball/local path): install again with the new file/path.
- Uninstall global: npm uninstall -g oomi

Verification
- After any global install, verify the CLI is on PATH:
  - oomi --version
  - oomi --help
