import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(__dirname, '..');
const renewalsRoot = 'C:\\Users\\Clean\\Documents\\Automatic  Renewals Project\\automatic-renewals';
const requireFromRenewals = createRequire(path.join(renewalsRoot, 'package.json'));
const { chromium } = requireFromRenewals('@playwright/test') as typeof import('@playwright/test');

const extensionRoot = path.join(repoRoot, 'Extentions', 'Browser-PDF-Webhook-Sender');
const profile = path.join(repoRoot, '.playwright', 'browser-pdf-webhook-sender-profile');
const statusFile = path.join(repoRoot, '.playwright', 'browser-pdf-webhook-sender-running.json');
const cdpPort = Number(process.env.BROWSER_PDF_PROFILE_CDP_PORT ?? 9338);
const agencyZoomUrl = process.env.AGENCY_ZOOM_URL ?? 'https://app.agencyzoom.com/login';
const apexUrl = process.env.APEX_URL ?? 'https://farmersagent.my.salesforce.com/';

type Workflow = typeof import('C:/Users/Clean/Documents/Automatic  Renewals Project/automatic-renewals/src/renewals/visible/agencyZoomVisibleWorkflow');
type CredentialStore = typeof import('C:/Users/Clean/Documents/Automatic  Renewals Project/automatic-renewals/src/renewals/credentials/dpapiCredentialStore');

function moduleUrl(relativePath: string): string {
  return pathToFileURL(path.join(renewalsRoot, relativePath)).href;
}

async function writeStatus(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(statusFile), { recursive: true });
  await fs.writeFile(statusFile, `${JSON.stringify({
    pid: process.pid,
    cdp: `http://127.0.0.1:${cdpPort}`,
    profile,
    extensionRoot,
    updatedAt: new Date().toISOString(),
    ...data,
  }, null, 2)}\n`);
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = url.search ? '?[redacted]' : '';
    url.hash = url.hash ? '#[redacted]' : '';
    return url.toString();
  } catch {
    return value;
  }
}

async function pageState(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return {
    title: await page.title().catch(() => ''),
    url: safeUrl(page.url()),
    sample: body
      .replace(/\b\d{6}\b/g, '******')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500),
  };
}

async function main(): Promise<void> {
  const workflow = await import(moduleUrl('src/renewals/visible/agencyZoomVisibleWorkflow.ts')) as Workflow;
  const credentialStore = await import(moduleUrl('src/renewals/credentials/dpapiCredentialStore.ts')) as CredentialStore;
  await fs.mkdir(profile, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });

  await writeStatus({ phase: 'opened' });

  const agencyPage = context.pages()[0] ?? await context.newPage();
  await agencyPage.goto(agencyZoomUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const agencyLogin = await workflow.tryAutoLoginFromGooglePasswordExport(
    agencyPage,
    agencyZoomUrl,
    path.join(renewalsRoot, 'secrets', 'imports', 'chrome-passwords-full-export.csv.dpapi'),
    process.env.RENEWALS_AGENCY_ZOOM_USERNAME ?? 'Ja',
  ).catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`);
  await agencyPage.waitForTimeout(3000);

  const apexPage = await context.newPage();
  await apexPage.goto(apexUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await workflow.clickApexOktaSsoIfPresent(apexPage, [apexUrl]).catch(() => false);
  await apexPage.waitForTimeout(1500);

  const apexCredential = await credentialStore.readSiteCredential(path.join(renewalsRoot, 'secrets'), 'apex');
  let apexLogin: unknown = 'no_form_or_existing_session';
  if (apexCredential) {
    apexLogin = await workflow.loginVisiblePageWithCredential(apexPage, {
      username: apexCredential.username,
      password: apexCredential.password,
      sourceHost: 'secure-vault:apex',
    }).catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`);
    await apexPage.waitForTimeout(3000);
  }

  const apexBody = await apexPage.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  let apexMfa: unknown = 'not_detected';
  if (/authentication factor|verification code|enter code|send code|sms/i.test(apexBody)) {
    apexMfa = await workflow.completeApexSmsMfaFromAgencyZoomText(
      context,
      apexPage,
      {
        agencyZoomUrl,
        googlePasswordExportPath: path.join(renewalsRoot, 'secrets', 'imports', 'chrome-passwords-full-export.csv.dpapi'),
        googlePasswordUsernameHint: process.env.RENEWALS_AGENCY_ZOOM_USERNAME ?? 'Ja',
        apexSmsMfa: {
          enabled: true,
          initialWaitMs: Number(process.env.RENEWALS_APEX_SMS_MFA_WAIT_MS ?? 10_000),
          agencyZoomTextReloads: Number(process.env.RENEWALS_APEX_SMS_MFA_AGENCYZOOM_RELOADS ?? 3),
          maxAttempts: 2,
        },
      },
      { log: () => undefined },
    ).then(() => 'completed').catch((error: unknown) => `blocked: ${error instanceof Error ? error.message : String(error)}`);
  }

  await writeStatus({
    phase: 'ready',
    agencyLogin,
    apexLogin,
    apexMfa,
    pages: {
      agencyZoom: await pageState(agencyPage),
      apex: await pageState(apexPage),
    },
  });

  await Promise.race([
    new Promise<void>((resolve) => context.on('close', () => resolve())),
    new Promise<void>((resolve) => process.once('SIGINT', () => resolve())),
  ]);
  await context.close().catch(() => undefined);
}

main().catch(async (error) => {
  await writeStatus({ phase: 'failed', error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  process.exit(1);
});
