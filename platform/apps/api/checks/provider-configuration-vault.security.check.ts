import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProviderConfigurationVault,
  ProviderConfigurationVaultError,
  type ProviderVaultDocument,
} from "../src/services/llm/provider-configuration-vault.ts";

const SECRET_MARKER = "provider-secret-acceptance-marker";
const ENDPOINT_PATH_MARKER = "private-tenant-path-marker";

async function vaultFixture() {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "provider-vault-security-"));
  const vault = await ProviderConfigurationVault.open(managedRoot);
  const dispose = () => rm(managedRoot, { recursive: true, force: true });
  return { managedRoot, vault, dispose };
}

function customConfiguration(document: ProviderVaultDocument) {
  const custom = document.providers.find(({ providerId }) => providerId === "custom");
  assert.ok(custom);
  return custom;
}

async function seedEncryptedVault() {
  const fixture = await vaultFixture();
  await fixture.vault.update((document) => {
    const custom = customConfiguration(document);
    custom.label = "Security fixture";
    custom.protocol = "openai-chat";
    custom.model = "fixture-model";
    custom.endpoint = `https://llm.example.test/v1/${ENDPOINT_PATH_MARKER}`;
    custom.credential = SECRET_MARKER;
    custom.version += 1;
    custom.configVersion += 1;
    custom.createdAt = new Date(0).toISOString();
    custom.updatedAt = new Date(0).toISOString();
  });
  return fixture;
}

function isVaultFailure(error: unknown): boolean {
  return error instanceof ProviderConfigurationVaultError
    && !error.message.includes(SECRET_MARKER)
    && !error.message.includes(ENDPOINT_PATH_MARKER);
}

test("PROV-AC-04/11: Vault keeps a 256-bit key and AES-GCM ciphertext in separate private files", async () => {
  const fixture = await seedEncryptedVault();
  try {
    const { key, ciphertext, directory } = fixture.vault.paths;
    assert.notEqual(key, ciphertext);
    assert.equal(path.dirname(key), directory);
    assert.equal(path.dirname(ciphertext), directory);
    assert.equal(directory.startsWith(await realpath(fixture.managedRoot) + path.sep), true);

    const [directoryStats, keyStats, ciphertextStats, keyBytes, encoded] = await Promise.all([
      lstat(directory),
      lstat(key),
      lstat(ciphertext),
      readFile(key),
      readFile(ciphertext, "utf8"),
    ]);
    assert.equal(directoryStats.isDirectory(), true);
    assert.equal(directoryStats.isSymbolicLink(), false);
    assert.equal(directoryStats.mode & 0o777, 0o700);
    for (const stats of [keyStats, ciphertextStats]) {
      assert.equal(stats.isFile(), true);
      assert.equal(stats.isSymbolicLink(), false);
      assert.equal(stats.mode & 0o777, 0o600);
    }
    assert.equal(keyBytes.length, 32, "AES-256 requires an exact 32-byte key");
    assert.doesNotMatch(encoded, new RegExp(`${SECRET_MARKER}|${ENDPOINT_PATH_MARKER}`, "u"));
    assert.equal(encoded.includes(keyBytes.toString("base64")), false, "ciphertext cannot embed its key");

    const envelope = JSON.parse(encoded) as Record<string, unknown>;
    assert.equal(envelope.algorithm, "aes-256-gcm");
    assert.equal(Buffer.from(String(envelope.nonce), "base64").length, 12);
    assert.equal(Buffer.from(String(envelope.authenticationTag), "base64").length, 16);
    assert.ok(Buffer.from(String(envelope.ciphertext), "base64").length > 0);

    const reopened = await ProviderConfigurationVault.open(fixture.managedRoot);
    const restored = customConfiguration(reopened.snapshot());
    assert.equal(restored.credential, SECRET_MARKER);
    assert.equal(restored.endpoint, `https://llm.example.test/v1/${ENDPOINT_PATH_MARKER}`);
  } finally {
    await fixture.dispose();
  }
});

test("PROV-AC-11: authentication-tag tampering and a missing key with existing ciphertext fail closed", async (t) => {
  await t.test("tampered authentication tag", async () => {
    const fixture = await seedEncryptedVault();
    try {
      const encoded = JSON.parse(
        await readFile(fixture.vault.paths.ciphertext, "utf8"),
      ) as Record<string, unknown>;
      const tag = Buffer.from(String(encoded.authenticationTag), "base64");
      tag[0] = tag[0]! ^ 0xff;
      encoded.authenticationTag = tag.toString("base64");
      await writeFile(
        fixture.vault.paths.ciphertext,
        `${JSON.stringify(encoded)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      await assert.rejects(
        () => ProviderConfigurationVault.open(fixture.managedRoot),
        isVaultFailure,
      );
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("ciphertext exists but key is missing", async () => {
    const fixture = await seedEncryptedVault();
    try {
      await unlink(fixture.vault.paths.key);
      await assert.rejects(
        () => ProviderConfigurationVault.open(fixture.managedRoot),
        isVaultFailure,
      );
      await assert.rejects(() => lstat(fixture.vault.paths.key), /ENOENT/u);
      assert.equal((await lstat(fixture.vault.paths.ciphertext)).isFile(), true);
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("key exists but ciphertext is missing", async () => {
    const fixture = await seedEncryptedVault();
    try {
      const originalKey = await readFile(fixture.vault.paths.key);
      await unlink(fixture.vault.paths.ciphertext);
      await assert.rejects(
        () => ProviderConfigurationVault.open(fixture.managedRoot),
        isVaultFailure,
      );
      assert.deepEqual(
        await readFile(fixture.vault.paths.key),
        originalKey,
        "a partial pair must not rotate or overwrite the surviving master key",
      );
      await assert.rejects(() => lstat(fixture.vault.paths.ciphertext), /ENOENT/u);
    } finally {
      await fixture.dispose();
    }
  });
});

test("PROV-AC-11: permissive files, symlinks, and a residual owned temp file are never accepted", async (t) => {
  await t.test("ciphertext mode is not 0600", async () => {
    const fixture = await seedEncryptedVault();
    try {
      await chmod(fixture.vault.paths.ciphertext, 0o644);
      await assert.rejects(
        () => ProviderConfigurationVault.open(fixture.managedRoot),
        isVaultFailure,
      );
    } finally {
      await fixture.dispose();
    }
  });

  for (const target of ["key", "ciphertext"] as const) {
    await t.test(`${target} symlink`, async () => {
      const fixture = await seedEncryptedVault();
      const original = `${fixture.vault.paths[target]}.original`;
      try {
        await rename(fixture.vault.paths[target], original);
        await symlink(original, fixture.vault.paths[target]);
        await assert.rejects(
          () => ProviderConfigurationVault.open(fixture.managedRoot),
          isVaultFailure,
        );
      } finally {
        await fixture.dispose();
      }
    });
  }

  await t.test("residual temp file", async () => {
    const fixture = await seedEncryptedVault();
    try {
      const residual = path.join(
        fixture.vault.paths.directory,
        `.provider-config.vault.${randomUUID()}.tmp`,
      );
      await writeFile(residual, "interrupted-write-marker\n", { mode: 0o600 });
      await assert.rejects(
        () => ProviderConfigurationVault.open(fixture.managedRoot),
        isVaultFailure,
      );
      assert.equal(
        await readFile(fixture.vault.paths.ciphertext, "utf8")
          .then((value) => value.includes("interrupted-write-marker")),
        false,
        "a temp file must never replace the last committed ciphertext",
      );
    } finally {
      await fixture.dispose();
    }
  });
});

test("PROV-AC-11: an interrupted atomic write leaves the prior in-memory and on-disk generation intact", async () => {
  const fixture = await seedEncryptedVault();
  const before = fixture.vault.snapshot();
  const displacedDirectory = `${fixture.vault.paths.directory}.temporarily-unavailable`;
  try {
    await rename(fixture.vault.paths.directory, displacedDirectory);
    await assert.rejects(
      () => fixture.vault.update((document) => {
        const custom = customConfiguration(document);
        custom.model = "must-not-commit";
        custom.version += 1;
        custom.configVersion += 1;
      }),
      isVaultFailure,
    );
    assert.deepEqual(fixture.vault.snapshot(), before);

    await rename(displacedDirectory, fixture.vault.paths.directory);
    const reopened = await ProviderConfigurationVault.open(fixture.managedRoot);
    assert.deepEqual(reopened.snapshot(), before);
  } finally {
    await rename(displacedDirectory, fixture.vault.paths.directory).catch(() => undefined);
    await fixture.dispose();
  }
});
