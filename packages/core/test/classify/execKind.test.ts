// packages/core/test/classify/execKind.test.ts — behaviour tests for the
// command-head rules of docs/EVENTS.md §Classification: every documented head
// lands in its bucket, `sed -i` and redirects count as edits, and file or web
// commands on the shell refine the category instead of staying `exec`.

import { describe, expect, it } from "vitest";

import { classifyShellCommand, execKindFromCommand } from "../../src/classify/execKind.js";

describe("execKindFromCommand", () => {
  it("classifies test heads", () => {
    for (const command of [
      "pytest tests/",
      "jest --runInBand",
      "vitest run --no-color",
      "go test ./...",
      "cargo test",
      "npm test",
      "pnpm test",
      "mvn test",
      "rspec spec/",
      "phpunit tests/",
      "dotnet test",
      "make test",
    ]) {
      expect(execKindFromCommand(command), command).toBe("test");
    }
  });

  it("classifies build heads", () => {
    for (const command of [
      "tsc --noEmit",
      "go build ./cmd/main",
      "cargo build --release",
      "npm run build",
      "pnpm run build",
      "gradle build",
      "docker build -t app .",
      "make",
    ]) {
      expect(execKindFromCommand(command), command).toBe("build");
    }
  });

  it("classifies lint heads", () => {
    for (const command of [
      "eslint src/",
      "biome check .",
      "ruff check .",
      "clippy",
      "golangci-lint run",
      "prettier --check src/",
    ]) {
      expect(execKindFromCommand(command), command).toBe("lint");
    }
  });

  it("classifies git heads", () => {
    expect(execKindFromCommand("git status")).toBe("git");
    expect(execKindFromCommand("git checkout -b feature/x")).toBe("git");
    expect(execKindFromCommand("gh pr create")).toBe("git");
  });

  it("classifies install heads", () => {
    for (const command of [
      "npm i",
      "npm install --save",
      "pnpm add zod",
      "pip install -r requirements.txt",
      "cargo add anyhow",
      "brew install ripgrep",
      "apt install jq",
    ]) {
      expect(execKindFromCommand(command), command).toBe("install");
    }
  });

  it("classifies run heads", () => {
    for (const command of [
      "node server.js",
      "python main.py",
      "python3 main.py",
      "go run ./cmd",
      "cargo run",
      "npm run dev",
      "pnpm run dev",
    ]) {
      expect(execKindFromCommand(command), command).toBe("run");
    }
  });

  it("is agent- and path-agnostic about the binary", () => {
    expect(execKindFromCommand("./node_modules/.bin/vitest run")).toBe("test");
    expect(execKindFromCommand("/usr/local/bin/node server.js")).toBe("run");
  });

  it("falls through to other for unlisted binaries", () => {
    for (const command of ["vim src/app.ts", "sleep 5", "ls -la", "gitignore init"]) {
      expect(execKindFromCommand(command), command).toBe("other");
    }
  });

  it("returns other for an empty command", () => {
    expect(execKindFromCommand("   ")).toBe("other");
  });
});

describe("classifyShellCommand", () => {
  it("refines file-reading commands to read", () => {
    expect(classifyShellCommand("cat src/app.ts")).toEqual({
      category: "read",
      target: "src/app.ts",
    });
    expect(classifyShellCommand("head -n 20 README.md").category).toBe("read");
    expect(classifyShellCommand("less log.txt").category).toBe("read");
  });

  it("refines search heads to search", () => {
    expect(classifyShellCommand("rg TODO src").category).toBe("search");
    expect(classifyShellCommand("find . -name '*.ts'").category).toBe("search");
    expect(classifyShellCommand("ls -la src").category).toBe("search");
  });

  it("refines `sed -i` to edit with the file as target", () => {
    const result = classifyShellCommand("sed -i 's/one/two/' src/app.ts");
    expect(result.category).toBe("edit");
    expect(result.target).toBe("src/app.ts");
  });

  it("refines file-writing redirects to edit", () => {
    expect(classifyShellCommand("echo hi > README.md").category).toBe("edit");
    expect(classifyShellCommand("cat a b >> out.tsv").category).toBe("edit");
  });

  it("refines attached redirects to edit without losing the target", () => {
    expect(classifyShellCommand("echo hi >README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
    expect(classifyShellCommand("echo hi >>README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
  });

  it("refines file-descriptor redirects to edit", () => {
    expect(classifyShellCommand("echo hi 2>README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
    expect(classifyShellCommand("echo hi 2>>README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
    expect(classifyShellCommand("echo hi &>README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
    expect(classifyShellCommand("echo hi &>>README.md")).toEqual({
      category: "edit",
      target: "README.md",
    });
  });

  it("keeps a dup redirect (2>&1) as exec, not edit", () => {
    expect(classifyShellCommand("echo hi 2>&1").category).toBe("exec");
  });

  it("refines curl and wget to web", () => {
    expect(classifyShellCommand("curl https://example.com/x.json").category).toBe("web");
    expect(classifyShellCommand("wget https://example.com/data.zip").category).toBe("web");
  });

  it("keeps anything else exec with its execKind", () => {
    expect(classifyShellCommand("pytest tests/unit")).toEqual({
      category: "exec",
      execKind: "test",
    });
    expect(classifyShellCommand("node server.js")).toEqual({ category: "exec", execKind: "run" });
  });
});
