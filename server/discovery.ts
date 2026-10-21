import { spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { localAddresses } from './network.js';
import { SATELLITE_PROTOCOL } from './satellites.js';

/** Service annoncé sur le réseau local pour que les satellites trouvent Cornelius seuls. */
export const SATELLITE_SERVICE_TYPE = 'cornelius';
// Wi-Fi branché, nouvelle adresse de la box : les annonces suivent les interfaces.
const REFRESH_MS = 30_000;

/**
 * Annonce mDNS (`_cornelius._tcp`) du WebSocket des satellites, sur le port HTTPS du réseau
 * local. Une annonce par interface : sans cela, les réponses ne partent que par l’interface
 * par défaut (l’Ethernet, par exemple) et un satellite en Wi-Fi ne les entend pas. Le texte du
 * service donne le chemin, la version du protocole et l’empreinte de la clé : une simple
 * indication, le satellite vérifie toujours la clé lors de la connexion TLS.
 * Rend la fonction qui retire les annonces.
 */
export function announceSatellites(options: {
  port: number;
  keyFingerprint: string | null;
  onError?: (error: unknown) => void;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}): () => Promise<void> {
  if ((options.platform ?? process.platform) === 'darwin') return announceWithDnsSd(options);
  let publishers = new Map<string, Bonjour>();
  const publish = (address: string) => {
    // Options transmises à multicast-dns (son type ne les déclare pas) : l’interface d’écoute.
    const bonjour = new Bonjour(
      { interface: address } as ConstructorParameters<typeof Bonjour>[0],
      (error: unknown) => options.onError?.(error),
    );
    bonjour.publish({
      name: 'Cornelius ' + hostname(),
      type: SATELLITE_SERVICE_TYPE,
      protocol: 'tcp',
      port: options.port,
      // Le même nom est annoncé sur chaque interface : ce n’est pas un conflit à résoudre.
      probe: false,
      txt: serviceText(options.keyFingerprint),
    });
    return bonjour;
  };
  const withdraw = (bonjour: Bonjour) =>
    new Promise<void>((resolve) =>
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      }),
    );
  const refresh = () => {
    const addresses = new Set(localAddresses());
    const next = new Map<string, Bonjour>();
    for (const [address, bonjour] of publishers)
      if (addresses.has(address)) next.set(address, bonjour);
      else void withdraw(bonjour);
    for (const address of addresses) if (!next.has(address)) next.set(address, publish(address));
    publishers = next;
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.all([...publishers.values()].map(withdraw));
    publishers.clear();
  };
}

/** Texte du service : chemin, version du protocole et empreinte de la clé. */
function serviceText(keyFingerprint: string | null): Record<string, string> {
  return {
    path: '/satellite',
    protocol: String(SATELLITE_PROTOCOL),
    ...(keyFingerprint ? { key: keyFingerprint } : {}),
  };
}

/**
 * macOS : mDNSResponder occupe déjà le port 5353. L’annonce lui est confiée avec `dns-sd -R`,
 * qui reste actif tant que le service est enregistré et suit lui-même les interfaces.
 */
function announceWithDnsSd(options: {
  port: number;
  keyFingerprint: string | null;
  onError?: (error: unknown) => void;
  spawnProcess?: typeof spawn;
}): () => Promise<void> {
  const text = Object.entries(serviceText(options.keyFingerprint)).map(([k, v]) => k + '=' + v);
  const child: ChildProcess = (options.spawnProcess ?? spawn)(
    '/usr/bin/dns-sd',
    [
      '-R',
      'Cornelius ' + hostname(),
      '_' + SATELLITE_SERVICE_TYPE + '._tcp',
      'local',
      String(options.port),
      ...text,
    ],
    { stdio: 'ignore' },
  );
  let stopping = false;
  child.on('error', (error) => options.onError?.(error));
  child.on('exit', (code, signal) => {
    if (!stopping)
      options.onError?.(new Error(`dns-sd s’est arrêté (${signal ?? 'code ' + code}).`));
  });
  return async () => {
    stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  };
}
