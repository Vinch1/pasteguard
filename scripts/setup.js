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
    console.error(
      "\n✗ Podman not found. Please install Podman:"
    );
    console.error("  https://podman.io/docs/installation\n");
    process.exit(1);
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
