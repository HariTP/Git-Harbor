#!/usr/bin/env python3
"""
Antigravity CLI "Auto Mode" - Pure Local Shell & AST Risk Analyzer
Zero API, Zero Key, Zero Deprecations, Microsecond Execution.

Parses command pipelines, compound statements (&&, ||, ;, subshells), and bash tokens
to classify commands into:
  - "allow"     : safe commands, inspections, tests, builds inside workspace
  - "deny"      : catastrophic/destructive commands, disk formats, privilege escalations
  - "ask"       : ambiguous commands, system changes, or potentially sensitive file actions
"""

import json
import os
import re
import shlex
import sys

# ==============================================================================
# 1. HARD DENY RULES (Catastrophic, Destructive, or Malicious)
# ==============================================================================

DENY_PATTERNS = [
    # Fork bombs
    r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;",
    # Raw disk formatting / partition operations
    r"\b(mkfs|fdisk|parted|sfparted|gdisk|cfdisk|wipefs)\b",
    # Raw block device or disk write operations
    r"\bdd\s+if=",
    r">\s*/dev/(sd[a-z]|nvme[0-9]|vd[a-z]|loop[0-9]|mem|kmem|port)",
    # Root / home destruction or wide wipe
    r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(/\s*$|/\*|~\s*$|~\*|/home\s*$|/root\s*$|/etc\b|/usr\b|/bin\b|/boot\b|/sys\b)",
    # Privilege escalation / administrative bypass
    r"\b(sudo|su|doas|pkexec)\b",
    # Direct remote piping into shell
    r"\b(curl|wget|fetch|nc|ncat|netcat)\b.*\|\s*(sh|bash|zsh|dash|ksh)\b",
    # Kernel & system state modifications
    r"\b(reboot|shutdown|poweroff|halt|init\s+[0-6]|systemctl\s+(reboot|poweroff|halt))\b",
    r"\b(insmod|rmmod|modprobe)\b",
    # Destructive network / firewall commands
    r"\b(iptables\s+-F|nft\s+flush|ufw\s+disable)\b",
    # Chmod full unconstrained root wipe
    r"\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(777|000)\s+(/|/\*|/home|/root|/etc)",
]

DENY_COMMANDS = {
    "mkfs", "fdisk", "parted", "wipefs", "dd",
    "sudo", "su", "doas", "pkexec",
    "reboot", "shutdown", "poweroff", "halt",
    "insmod", "rmmod", "modprobe",
    "passwd", "useradd", "userdel", "usermod", "groupadd", "groupdel"
}

# ==============================================================================
# 2. EXTENSIVE LINUX & DEV TOOL AUTO-ALLOW SPECIFICATIONS
# ==============================================================================

READ_ONLY_INSPECTORS = {
    # File viewing & text processing
    "cat", "head", "tail", "nl", "less", "more", "fold", "fmt", "column",
    "wc", "grep", "egrep", "fgrep", "ripgrep", "rg", "ag", "ack",
    "cut", "paste", "awk", "gawk", "sed", "sort", "uniq", "tr", "diff",
    "cmp", "comm", "strings", "od", "hexdump", "xxd", "base64", "jq",
    # Directory & search
    "ls", "dir", "vdir", "tree", "find", "fd", "locate", "which", "whereis",
    "type", "file", "stat", "realpath", "readlink", "dirname", "basename",
    "pwd",
    # System info & inspection (read-only)
    "uname", "hostname", "whoami", "id", "uptime", "date", "cal",
    "df", "du", "free", "vmstat", "lscpu", "lshw", "lspci", "lsusb",
    "ps", "top", "htop", "pgrep", "pstree", "env", "printenv",
    # Network diagnostic inspection (no mutate)
    "ping", "traceroute", "tracepath", "host", "nslookup", "dig",
    "ip", "ifconfig", "ss", "netstat",
    # Archive inspection
    "tar", "unzip", "zipinfo", "gzip", "gunzip", "bzip2", "bunzip2", "xz",
    # Tool versions / info
    "echo", "printf", "test", "[", "true", "false", "sleep", "clear"
}

DEV_TOOLS_SUBCOMMANDS = {
    "git": {
        "allow": {
            "status", "diff", "log", "branch", "show", "rev-parse", "rev-list",
            "describe", "config", "stash", "blame", "check-ref-format",
            "cat-file", "ls-remote", "ls-files", "ls-tree", "merge-base",
            "symbolic-ref", "tag", "fetch", "remote", "version", "bundle", "fsck"
        },
        "ask": {
            "commit", "add", "checkout", "switch", "restore", "pull", "merge",
            "rebase", "cherry-pick", "revert", "reset", "clean", "push"
        }
    },
    "npm": {
        "allow": {
            "test", "run", "run-script", "build", "lint", "typecheck",
            "check", "list", "ls", "outdated", "view", "info", "explain",
            "audit", "pack", "version", "--version", "-v"
        },
        "ask": {
            "install", "i", "ci", "update", "uninstall", "publish", "link"
        }
    },
    "npx": {
        "allow": {
            "eslint", "tsc", "vitest", "jest", "prettier", "rimraf", "ts-node",
            "biome", "pyright", "typecheck"
        },
        "ask": set()
    },
    "pnpm": {
        "allow": {
            "test", "run", "build", "lint", "typecheck", "list", "ls", "outdated", "audit"
        },
        "ask": { "install", "i", "add", "remove", "update", "publish" }
    },
    "yarn": {
        "allow": {
            "test", "run", "build", "lint", "typecheck", "list", "info", "audit"
        },
        "ask": { "install", "add", "remove", "publish" }
    },
    "cargo": {
        "allow": { "check", "test", "build", "clippy", "fmt", "tree", "metadata", "version", "--version" },
        "ask": { "publish", "install", "clean" }
    },
    "python": {
        "allow_flags": {"-m", "--version", "-V", "-c"},
        "allow_modules": {"pytest", "unittest", "mypy", "flake8", "black", "ruff", "pylint", "http.server"}
    },
    "python3": {
        "allow_flags": {"-m", "--version", "-V", "-c"},
        "allow_modules": {"pytest", "unittest", "mypy", "flake8", "black", "ruff", "pylint", "http.server"}
    },
    "pytest": {"allow_all": True},
    "go": {
        "allow": {"test", "vet", "build", "version", "env", "doc"},
        "ask": {"get", "install", "clean", "mod"}
    },
    "tsc": {"allow_all": True},
    "eslint": {"allow_all": True},
    "vitest": {"allow_all": True},
    "jest": {"allow_all": True},
    "prettier": {"allow_all": True},
    "node": {
        "allow_flags": {"-v", "--version", "-e", "--test"}
    }
}

# ==============================================================================
# 3. SHELL PARSING & CLAUSE CLASSIFIER
# ==============================================================================

def split_pipeline_and_compounds(cmd_line: str):
    token_pattern = r"(?:&&|\|\||;|\||\n)"
    chunks = re.split(token_pattern, cmd_line)
    return [c.strip() for c in chunks if c.strip()]

def evaluate_atomic_command(cmd_chunk: str, workspace_paths: list[str]) -> tuple[str, str]:
    if not cmd_chunk:
        return "allow", "Empty command chunk"

    try:
        tokens = shlex.split(cmd_chunk)
    except ValueError:
        tokens = cmd_chunk.split()

    if not tokens:
        return "allow", "Empty command chunk"

    bin_name = os.path.basename(tokens[0])

    # 1. Immediate Hard Deny
    if bin_name in DENY_COMMANDS:
        return "deny", f"Command '{bin_name}' is blocked by critical safety policy"

    for pattern in DENY_PATTERNS:
        if re.search(pattern, cmd_chunk):
            return "deny", f"Command matched high-risk pattern '{pattern}'"

    # 2. Package Manager Global Installs
    if bin_name in ("npm", "yarn", "pnpm"):
        if "-g" in tokens or "--global" in tokens:
            return "ask", f"Global package modification with {bin_name}"

    # 3. Git Specific Rules
    if bin_name == "git":
        subcmd = next((t for t in tokens[1:] if not t.startswith("-")), "")
        if not subcmd or subcmd in ("--version", "--help"):
            return "allow", "Safe git diagnostic"

        if subcmd == "push":
            if any(t in ("-f", "--force", "+") or t.startswith("--force-") for t in tokens):
                return "ask", "Git force push requested"
            return "ask", "Git push modifies remote repository state"

        if subcmd in DEV_TOOLS_SUBCOMMANDS["git"]["allow"]:
            return "allow", f"Safe git command (git {subcmd})"
        elif subcmd in DEV_TOOLS_SUBCOMMANDS["git"]["ask"]:
            return "ask", f"Git state-modifying command (git {subcmd})"
        else:
            return "ask", f"Unclassified git subcommand ({subcmd})"

    # 4. Standard Dev Build/Test Tools
    if bin_name in DEV_TOOLS_SUBCOMMANDS:
        spec = DEV_TOOLS_SUBCOMMANDS[bin_name]
        if spec.get("allow_all"):
            return "allow", f"Standard developer utility ({bin_name})"

        if bin_name in ("python", "python3"):
            if "-m" in tokens:
                idx = tokens.index("-m")
                if idx + 1 < len(tokens) and tokens[idx + 1] in spec["allow_modules"]:
                    return "allow", f"Safe Python module invocation ({tokens[idx + 1]})"
            elif any(tokens[1:] == [f] for f in spec["allow_flags"]):
                return "allow", "Python inspection/version check"
            return "ask", f"Arbitrary python script execution: {cmd_chunk}"

        if bin_name == "node":
            if len(tokens) == 2 and tokens[1] in ("-v", "--version"):
                return "allow", "Node version check"
            return "ask", "Arbitrary node script execution"

        subcmd = next((t for t in tokens[1:] if not t.startswith("-")), "")
        if not subcmd or subcmd in ("--version", "-v", "--help", "-h"):
            return "allow", f"Safe {bin_name} version/help check"

        if subcmd in spec.get("allow", set()):
            return "allow", f"Standard dev task ({bin_name} {subcmd})"
        elif subcmd in spec.get("ask", set()):
            return "ask", f"Modifying project dependencies/state ({bin_name} {subcmd})"

    # 5. Read-only Linux Inspectors
    if bin_name in READ_ONLY_INSPECTORS:
        if ">" in cmd_chunk:
            return "ask", f"Redirected write output in inspection command: {cmd_chunk}"
        return "allow", f"Read-only system inspector ({bin_name})"

    # 6. File Manipulations confined to workspace
    if bin_name in ("mkdir", "touch", "cp", "mv", "rm"):
        for t in tokens[1:]:
            if t.startswith("/") and not any(t.startswith(wp) for wp in workspace_paths):
                return "ask", f"File operation outside workspace ({t})"
            if t in ("..", "~") or t.startswith("~/"):
                return "ask", f"File operation targets parent or home ({t})"
        if bin_name == "rm":
            return "ask", f"Removal operation ({cmd_chunk})"
        return "allow", f"Workspace-contained file operation ({bin_name})"

    # 7. Unclassified commands default to "ask"
    return "ask", f"Unclassified command '{bin_name}' - prompting for safety review"

# ==============================================================================
# 4. MAIN HOOK ENTRY POINT
# ==============================================================================

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"decision": "ask", "reason": "No input provided to auto mode classifier"}))
            return

        payload = json.loads(raw_input)
        tool_call = payload.get("toolCall", {})
        tool_name = tool_call.get("name", "")

        if tool_name != "run_command":
            print(json.dumps({"decision": "allow"}))
            return

        cmd_line = tool_call.get("args", {}).get("CommandLine", "").strip()
        workspace_paths = payload.get("workspacePaths", [os.getcwd()])

        if not cmd_line:
            print(json.dumps({"decision": "allow", "reason": "Empty command"}))
            return

        sub_commands = split_pipeline_and_compounds(cmd_line)
        decisions = []

        for sub_cmd in sub_commands:
            dec, reason = evaluate_atomic_command(sub_cmd, workspace_paths)
            decisions.append((dec, reason))

        # Resolution hierarchy: Deny > Ask > Allow
        for dec, reason in decisions:
            if dec == "deny":
                print(json.dumps({
                    "decision": "deny",
                    "reason": f"[Auto Mode - Blocked] {reason}"
                }))
                return

        for dec, reason in decisions:
            if dec == "ask":
                print(json.dumps({
                    "decision": "ask",
                    "reason": f"[Auto Mode - Review] {reason}"
                }))
                return

        print(json.dumps({
            "decision": "allow",
            "reason": "[Auto Mode - Allowed] Verified safe developer command",
            "permissionOverrides": [f"command({cmd_line})"]
        }))

    except Exception as err:
        print(json.dumps({
            "decision": "ask",
            "reason": f"[Auto Mode - Error] Fallback to user confirmation: {str(err)}"
        }))

if __name__ == "__main__":
    main()
