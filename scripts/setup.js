#!/usr/bin/env node

import { execSync, spawn } from "child_process";
import { platform } from "os";

const IS_WINDOWS = platform() === "win32";

function checkCommandExists(command) {
  try {
    execSync(`${IS_WINDOWS ? "where" : "which"} ${command}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function installBun() {
  console.log("📦 Bun not found. Installing...\n");

  const installCmd = IS_WINDOWS
    ? 'powershell -c "irm https://bun.sh/install.ps1|iex"'
    : 'curl -fsSL https://bun.sh/install | bash';

  try {
    execSync(installCmd, { stdio: "inherit" });
    console.log(
      "\n✓ Bun installed successfully!\n"
    );
  } catch (error) {
    console.error("✗ Failed to install Bun. Please install manually:");
    console.error("  Windows: https://bun.sh/docs/installation");
    console.error("  macOS/Linux: https://bun.sh/docs/installation\n");
    process.exit(1);
  }
}

async function installChocolatey() {
  console.log("📦 Chocolatey not found. Installing...\n");

  const installCmd =
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString(\'https://community.chocolatey.org/install.ps1\'))"';

  try {
    execSync(installCmd, { stdio: "inherit" });
    console.log("\n✓ Chocolatey installed successfully!\n");
  } catch (error) {
    console.error("✗ Failed to install Chocolatey. Please install manually:");
    console.error("  https://chocolatey.org/install\n");
    process.exit(1);
  }
}

async function installPodman() {
  console.log("📦 Podman not found. Installing...\n");

  let installCmd;
  const osType = process.platform;

  if (osType === "win32") {
    // Windows: Ensure Chocolatey is installed first
    if (!checkCommandExists("choco")) {
      await installChocolatey();
    }
    // Windows: Use Chocolatey to install Podman Desktop
    installCmd = 'powershell -c "choco install podman-desktop -y"';
  } else if (osType === "darwin") {
    // macOS: Use Homebrew
    installCmd = "brew install podman";
  } else {
    // Linux: Use package manager
    const linuxDistro = await detectLinuxDistro();
    if (linuxDistro.includes("ubuntu") || linuxDistro.includes("debian")) {
      installCmd = "sudo apt-get update && sudo apt-get install -y podman";
    } else if (linuxDistro.includes("fedora") || linuxDistro.includes("rhel")) {
      installCmd = "sudo dnf install -y podman";
    } else if (linuxDistro.includes("arch")) {
      installCmd = "sudo pacman -S podman";
    } else {
      // Fallback to generic installation instructions
      showPodmanInstallationInstructions();
      return;
    }
  }

  try {
    execSync(installCmd, { stdio: "inherit" });
    console.log("\n✓ Podman installed successfully!\n");
  } catch (error) {
    console.error("✗ Failed to install Podman. Please install manually:");
    showPodmanInstallationInstructions();
    process.exit(1);
  }
}

async function detectLinuxDistro() {
  try {
    const output = execSync("cat /etc/os-release", { encoding: "utf-8" });
    return output.toLowerCase();
  } catch {
    return "";
  }
}

function showPodmanInstallationInstructions() {
  console.error("\n📖 Installation Instructions:");
  console.error("  Windows: https://podman.io/docs/installation/windows");
  console.error("  macOS: https://podman.io/docs/installation/mac");
  console.error("  Linux: https://podman.io/docs/installation/linux\n");
}

function startServices() {
  console.log("🚀 Starting services...\n");

  // Start Podman Presidio
  console.log("📦 Starting presidio-analyzer container...");
  try {
    execSync("podman compose up presidio-analyzer -d", { stdio: "inherit" });
  } catch (error) {
    console.error(
      "✗ Failed to start Podman. Make sure Podman is installed and running."
    );
    process.exit(1);
  }

  console.log("\n🔥 Starting Bun development server...\n");

  // Start Bun dev server
  spawn("bun", ["run", "--hot", "src/index.ts"], {
    stdio: "inherit",
    shell: true,
  });
}

async function main() {
  console.log("🔍 Checking dependencies...\n");

  // Check Bun
  if (!checkCommandExists("bun")) {
    await installBun();
  } else {
    const bunVersion = execSync("bun --version", { encoding: "utf-8" }).trim();
    console.log(`✓ Bun ${bunVersion} found`);
  }

  // Check Podman
  if (!checkCommandExists("podman")) {
    await installPodman();
  } else {
    console.log("✓ Podman found");
  }

  console.log("\n✓ All dependencies ready!\n");
  startServices();
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
