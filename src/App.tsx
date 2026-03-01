import { FormEvent, useEffect, useMemo, useState } from "react";
import type { BootstrapPayload, DiscoveryCandidate, DiscoveryStatusPayload, GameRecord, GoogleOAuthPayload, LaunchType, SyncEventPayload } from "./vite-env";

type TopView = "library" | "discovery" | "cloud" | "activity";
type LibraryTab = "summary" | "saves" | "paths" | "manage";

type GameFormState = {
  title: string;
  processName: string;
  savePath: string;
  executablePath: string;
  installRoot: string;
  filePatterns: string;
  launchType: LaunchType;
  launchTarget: string;
};

type OAuthFormState = GoogleOAuthPayload;

const emptyForm = (): GameFormState => ({
  title: "",
  processName: "",
  savePath: "",
  executablePath: "",
  installRoot: "",
  filePatterns: "**/*",
  launchType: "exe",
  launchTarget: ""
});

const toFormState = (game: GameRecord | null): GameFormState =>
  game
    ? {
        title: game.title,
        processName: game.processName,
        savePath: game.savePath,
        executablePath: game.executablePath || "",
        installRoot: game.installRoot || "",
        filePatterns: game.filePatterns.join(", "),
        launchType: game.launchType || "exe",
        launchTarget: game.launchTarget || game.executablePath || ""
      }
    : emptyForm();

const formatDate = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "Sin registro";

const formatDuration = (seconds?: number) => {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours && !minutes) return "< 1 min";
  if (!hours) return `${minutes} min`;
  return `${hours} h ${minutes} min`;
};

const splitPatterns = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const launchHelp = (launchType: LaunchType) => {
  if (launchType === "steam") return "App ID o URI steam://";
  if (launchType === "uri") return "URI externa o deep link";
  if (launchType === "command") return "Comando completo";
  return "Ruta al ejecutable";
};

function App() {
  const oauthHelpSlides = [
    {
      title: "1. Abre Google Cloud Console",
      body: "Entra a Google Cloud Console. Desde aqui vas a crear o elegir el proyecto donde quedaran tu cliente OAuth y el acceso a Google Drive.",
      imagePath: "help/google-oauth/step-1-console-home.png",
      links: [
        { label: "Google Cloud Console", href: "https://console.cloud.google.com/" }
      ]
    },
    {
      title: "2. Abre el selector de proyecto",
      body: "Haz click en Selecciona un proyecto para abrir el selector. Desde ahi puedes crear uno nuevo si todavia no existe.",
      imagePath: "help/google-oauth/step-2-project-picker.png",
      links: [
        { label: "Selector de proyectos", href: "https://console.cloud.google.com/" }
      ]
    },
    {
      title: "3. Crea un proyecto nuevo",
      body: "Dentro del selector, pulsa Proyecto nuevo. Asigna un nombre identificable como SincGames y crea el proyecto.",
      imagePath: "help/google-oauth/step-3-project-new.png",
      links: [
        { label: "Crear proyecto", href: "https://console.cloud.google.com/projectcreate" }
      ]
    },
    {
      title: "4. Vuelve al selector de proyecto",
      body: "Cuando termine la creacion, vuelve a abrir el selector de proyecto para elegir el proyecto que acabas de crear.",
      imagePath: "help/google-oauth/step-4-project-picker-return.png",
      links: [
        { label: "Google Cloud Console", href: "https://console.cloud.google.com/" }
      ]
    },
    {
      title: "5. Selecciona tu proyecto",
      body: "Busca el proyecto que acabas de crear y seleccionarlo. Todo lo que hagas despues debe quedar dentro de ese proyecto.",
      imagePath: "help/google-oauth/step-5-project-select.png",
      links: [
        { label: "Tus proyectos", href: "https://console.cloud.google.com/" }
      ]
    },
    {
      title: "6. Busca APIs y servicios",
      body: "Con el proyecto ya activo, usa la barra de busqueda y entra a APIs y servicios. Desde ahi vas a habilitar Google Drive API.",
      imagePath: "help/google-oauth/step-6-search-apis-services.png",
      links: [
        { label: "APIs y servicios", href: "https://console.cloud.google.com/apis/dashboard" }
      ]
    },
    {
      title: "7. Busca Google Drive API",
      body: "Dentro de APIs y servicios, escribe drive y abre Google Drive API. Asegurate de abrir la API oficial de Google Drive.",
      imagePath: "help/google-oauth/step-7-search-drive-api.png",
      links: [
        { label: "Biblioteca de APIs", href: "https://console.cloud.google.com/apis/library/drive.googleapis.com" }
      ]
    },
    {
      title: "8. Habilita Google Drive API",
      body: "En la ficha de Google Drive API pulsa Habilitar. Sin este paso, SincGames no podra subir ni leer respaldos desde tu Drive.",
      imagePath: "help/google-oauth/step-8-enable-drive-api.png",
      links: [
        { label: "Google Drive API", href: "https://console.cloud.google.com/apis/library/drive.googleapis.com" }
      ]
    },
    {
      title: "9. Ve a Credenciales",
      body: "Abre la seccion Credenciales. Si aparece el aviso para configurar la pantalla de consentimiento, ese es el siguiente paso correcto.",
      imagePath: "help/google-oauth/step-9-credentials-warning.png",
      links: [
        { label: "Credenciales", href: "https://console.cloud.google.com/apis/credentials" }
      ]
    },
    {
      title: "10. Inicia Google Auth Platform",
      body: "Haz click en Comenzar para configurar Google Auth Platform. Aqui se define la pantalla de consentimiento y quien puede usar tu app.",
      imagePath: "help/google-oauth/step-10-oauth-start.png",
      links: [
        { label: "Google Auth Platform", href: "https://console.cloud.google.com/auth/overview" },
        { label: "Guia oficial", href: "https://developers.google.com/workspace/guides/configure-oauth-consent" }
      ]
    },
    {
      title: "11. Completa la informacion de la app",
      body: "Pon un nombre para la app, por ejemplo SincGames, y elige el correo de asistencia al usuario. Ese correo aparece en la pantalla de consentimiento.",
      imagePath: "help/google-oauth/step-11-branding-app-info.png",
      links: [
        { label: "Branding", href: "https://console.cloud.google.com/auth/branding" }
      ]
    },
    {
      title: "12. Configura el publico",
      body: "En el paso Publico deja la app como Externa y mantenla en modo Prueba. Esto permite usarla con tu propia cuenta sin pasar por verificacion publica.",
      imagePath: "help/google-oauth/step-12-branding-audience.png",
      links: [
        { label: "Publico", href: "https://console.cloud.google.com/auth/audience" }
      ]
    },
    {
      title: "13. Agrega el correo de contacto",
      body: "Escribe el correo del desarrollador o de contacto. Google usara esta direccion para notificar cambios importantes del proyecto.",
      imagePath: "help/google-oauth/step-13-contact-info.png",
      links: [
        { label: "Informacion de marca", href: "https://console.cloud.google.com/auth/branding" }
      ]
    },
    {
      title: "14. Finaliza la configuracion inicial",
      body: "Acepta la politica de datos del usuario de APIs de Google, pulsa Continuar y despues Crear. Con eso queda lista la configuracion base de OAuth.",
      imagePath: "help/google-oauth/step-14-finalize.png",
      links: [
        { label: "Resumen OAuth", href: "https://console.cloud.google.com/auth/overview" }
      ]
    },
    {
      title: "15. Crea el cliente OAuth",
      body: "De vuelta en la descripcion general, pulsa Crear cliente de OAuth. Ese cliente es el que le vas a pegar a SincGames.",
      imagePath: "help/google-oauth/step-15-create-oauth-client.png",
      links: [
        { label: "Clients", href: "https://console.cloud.google.com/auth/clients" }
      ]
    },
    {
      title: "16. Elige App de escritorio",
      body: "En Tipo de aplicacion selecciona App de escritorio. Ese es el tipo correcto para la app local de Windows.",
      imagePath: "help/google-oauth/step-16-desktop-app-type.png",
      links: [
        { label: "Crear cliente", href: "https://console.cloud.google.com/auth/clients/create" }
      ]
    },
    {
      title: "17. Asigna nombre y crea",
      body: "Deja un nombre reconocible para el cliente, por ejemplo Cliente de escritorio 1 o SincGames Desktop, y pulsa Crear.",
      imagePath: "help/google-oauth/step-17-create-desktop-client.png",
      links: [
        { label: "Crear cliente", href: "https://console.cloud.google.com/auth/clients/create" }
      ]
    },
    {
      title: "18. Copia Client ID y Client Secret",
      body: "Copia el ID de cliente y el Secreto del cliente. Guardalos de forma segura y luego pegalos en la seccion Nube de SincGames.",
      imagePath: "help/google-oauth/step-18-copy-client-id-secret.png",
      links: [
        { label: "Lista de clientes", href: "https://console.cloud.google.com/auth/clients" }
      ]
    },
    {
      title: "19. Agrega el usuario de prueba",
      body: "Abre la seccion Publico y pulsa Add users. Aqui vas a registrar el correo de Google con el que conectaras SincGames.",
      imagePath: "help/google-oauth/step-19-add-test-user.png",
      links: [
        { label: "Publico", href: "https://console.cloud.google.com/auth/audience" }
      ]
    },
    {
      title: "20. Guarda el correo autorizado",
      body: "Escribe el correo que usaras para conectar el programa y pulsa Guardar. Con esto queda creado y configurado el acceso a Google Drive para SincGames.",
      imagePath: "help/google-oauth/step-20-save-test-user.png",
      links: [
        { label: "Usuarios de prueba", href: "https://console.cloud.google.com/auth/audience" }
      ]
    }
  ] as const;

  const bridge = window.sincgames;
  const [bridgeError, setBridgeError] = useState<string | null>(bridge ? null : "No se cargo el bridge de Electron.");
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [activity, setActivity] = useState<SyncEventPayload[]>([]);
  const [topView, setTopView] = useState<TopView>("library");
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("summary");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [libraryFilter, setLibraryFilter] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [manualForm, setManualForm] = useState<GameFormState>(emptyForm);
  const [editForm, setEditForm] = useState<GameFormState>(emptyForm);
  const [oauthForm, setOauthForm] = useState<OAuthFormState>({
    clientId: "",
    clientSecret: "",
    redirectUri: "http://127.0.0.1:42813/oauth2/callback"
  });
  const [oauthNotice, setOauthNotice] = useState<string | null>(null);
  const [oauthHelpOpen, setOauthHelpOpen] = useState(false);
  const [oauthHelpIndex, setOauthHelpIndex] = useState(0);
  const [oauthHelpImageFailed, setOauthHelpImageFailed] = useState<Record<number, boolean>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatusPayload | null>(null);
  const [startupDismissed, setStartupDismissed] = useState(false);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!bridge) return;

    let mounted = true;

    bridge
      .getBootstrap()
      .then((payload) => {
        if (!mounted) return;
        setBootstrap(payload);
        setSelectedGameId((current) => current || payload.games[0]?.id || null);
      })
      .catch((error) => {
        if (!mounted) return;
        setBridgeError(error instanceof Error ? error.message : "No se pudo cargar la app.");
      });

    const offEvents = bridge.onSyncEvent((payload) => {
      setActivity((current) => [payload, ...current].slice(0, 120));
    });
    const offState = bridge.onStateUpdated((payload) => {
      setBootstrap(payload);
      setSelectedGameId((current) => {
        if (current && payload.games.some((game) => game.id === current)) return current;
        return payload.games[0]?.id || null;
      });
    });
    const offDiscovery = bridge.onDiscoveryStatus((payload) => {
      setDiscoveryStatus(payload);
    });

    return () => {
      mounted = false;
      offEvents();
      offState();
      offDiscovery();
    };
  }, [bridge]);

  const games = bootstrap?.games || [];
  const selectedGame = games.find((game) => game.id === selectedGameId) || games[0] || null;
  const scanRoots = bootstrap?.scanRoots || [];
  const discoveryCandidates = bootstrap?.discoveryCandidates || [];

  useEffect(() => {
    setEditForm(toFormState(selectedGame));
  }, [selectedGame]);

  useEffect(() => {
    if (!bootstrap) return;
    setOauthForm({
      clientId: bootstrap.env.googleOauthClientId || "",
      clientSecret: bootstrap.env.googleOauthClientSecret || "",
      redirectUri: bootstrap.env.googleOauthRedirectUri || "http://127.0.0.1:42813/oauth2/callback"
    });
  }, [bootstrap]);

  useEffect(() => {
    if (!games.some((game) => game.currentlyRunning && game.sessionStartedAt)) {
      return;
    }

    const timer = window.setInterval(() => {
      setLiveNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [games]);

  const getEffectivePlaySeconds = (game?: GameRecord | null) => {
    if (!game) return 0;

    const baseSeconds = Number(game.totalPlaySeconds || 0);
    if (!game.currentlyRunning || !game.sessionStartedAt) {
      return baseSeconds;
    }

    const startedAtMs = new Date(game.sessionStartedAt).getTime();
    if (Number.isNaN(startedAtMs)) {
      return baseSeconds;
    }

    return baseSeconds + Math.max(0, Math.round((liveNow - startedAtMs) / 1000));
  };

  const filteredGames = useMemo(() => {
    const needle = libraryFilter.trim().toLowerCase();
    if (!needle) return games;
    return games.filter((game) => [game.title, game.processName, game.savePath].join(" ").toLowerCase().includes(needle));
  }, [games, libraryFilter]);

  const selectedActivity = useMemo(
    () => activity.filter((item) => !selectedGame || item.gameId === selectedGame.id),
    [activity, selectedGame]
  );

  const totals = useMemo(
    () => ({
      games: games.length,
      local: games.filter((game) => game.latestLocalSave).length,
      remote: games.filter((game) => game.latestRemoteSave).length,
      time: games.reduce((sum, game) => sum + getEffectivePlaySeconds(game), 0)
    }),
    [games, liveNow]
  );

  const showStartupOverlay = Boolean(
    bootstrap?.startup.requiresStorageChoice && !startupDismissed
  );

  if (bridgeError) {
    return (
      <main className="bridge-error-screen">
        <section className="bridge-error-card">
          <p className="eyebrow">Estado</p>
          <h1>SincGames no pudo iniciar la interfaz</h1>
          <p>{bridgeError}</p>
        </section>
      </main>
    );
  }

  const updateManual = (field: keyof GameFormState, value: string) =>
    setManualForm((current) => ({ ...current, [field]: value }));
  const updateEdit = (field: keyof GameFormState, value: string) =>
    setEditForm((current) => ({ ...current, [field]: value }));

  const pickDirectoryInto = async (field: keyof GameFormState, mode: "manual" | "edit") => {
    if (!bridge) return;
    const directory = await bridge.pickDirectory();
    if (!directory) return;
    if (mode === "manual") updateManual(field, directory);
    else updateEdit(field, directory);
  };

  const addScanRoot = async () => {
    if (!bridge || !newRoot.trim()) return;
    setBusyAction("add-root");
    try {
      await bridge.addScanRoot(newRoot.trim());
      setNewRoot("");
    } finally {
      setBusyAction(null);
    }
  };

  const scanForGames = async () => {
    if (!bridge) return;
    setBusyAction("scan");
    try {
      await bridge.scanForGames();
    } catch (error) {
      setActivity((current) => [
        {
          type: "warning",
          gameId: null,
          message: error instanceof Error ? error.message : "No se pudo completar el escaneo."
        },
        ...current
      ]);
    } finally {
      setBusyAction(null);
    }
  };

  const importCandidate = async (candidate: DiscoveryCandidate) => {
    if (!bridge) return;
    setBusyAction(`import:${candidate.id}`);
    try {
      await bridge.addGameFromCandidate(candidate.id);
    } finally {
      setBusyAction(null);
    }
  };

  const submitManualGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bridge) return;
    setBusyAction("manual");
    try {
      await bridge.createManualGame({
        title: manualForm.title,
        processName: manualForm.processName,
        savePath: manualForm.savePath,
        executablePath: manualForm.executablePath,
        installRoot: manualForm.installRoot,
        filePatterns: splitPatterns(manualForm.filePatterns),
        launchType: manualForm.launchType,
        launchTarget: manualForm.launchTarget
      });
      setManualForm(emptyForm());
    } finally {
      setBusyAction(null);
    }
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bridge || !selectedGame) return;
    setBusyAction("edit");
    try {
      await bridge.updateGame({
        gameId: selectedGame.id,
        title: editForm.title,
        processName: editForm.processName,
        savePath: editForm.savePath,
        executablePath: editForm.executablePath,
        installRoot: editForm.installRoot,
        filePatterns: splitPatterns(editForm.filePatterns),
        launchType: editForm.launchType,
        launchTarget: editForm.launchTarget
      });
    } finally {
      setBusyAction(null);
    }
  };

  const launchGame = async (gameId: string) => {
    if (!bridge) return;
    setBusyAction(`launch:${gameId}`);
    try {
      await bridge.launchGame(gameId);
    } finally {
      setBusyAction(null);
    }
  };

  const restoreLatest = async (gameId: string) => {
    if (!bridge) return;
    setBusyAction(`restore:${gameId}`);
    try {
      await bridge.restoreLatestRemote(gameId);
    } finally {
      setBusyAction(null);
    }
  };

  const backupNow = async (gameId: string) => {
    if (!bridge) return;
    setBusyAction(`backup:${gameId}`);
    try {
      await bridge.backupNow(gameId);
    } catch (error) {
      setActivity((current) => [
        {
          type: "warning",
          gameId,
          message: error instanceof Error ? error.message : "No se pudo completar el respaldo manual."
        },
        ...current
      ]);
    } finally {
      setBusyAction(null);
    }
  };

  const startMonitoring = async () => {
    if (!bridge) return;
    setBusyAction("monitor");
    try {
      await bridge.startMonitoring();
    } finally {
      setBusyAction(null);
    }
  };

  const connectGoogle = async () => {
    if (!bridge) return;
    setBusyAction("google");
    try {
      await bridge.connectGoogleDrive();
      setStartupDismissed(true);
      setOauthNotice(null);
    } catch (error) {
      setActivity((current) => [
        {
          type: "warning",
          gameId: null,
          message: error instanceof Error ? error.message : "No se pudo iniciar la conexion con Google."
        },
        ...current
      ]);
    } finally {
      setBusyAction(null);
    }
  };

  const saveGoogleOAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bridge) return;
    setBusyAction("oauth-save");
    try {
      const result = await bridge.saveGoogleOAuth(oauthForm);
      setOauthNotice(`Credenciales guardadas correctamente en ${result.envFilePath}.`);
    } catch (error) {
      setOauthNotice(null);
      setActivity((current) => [
        {
          type: "warning",
          gameId: null,
          message: error instanceof Error ? error.message : "No se pudieron guardar las credenciales OAuth."
        },
        ...current
      ]);
    } finally {
      setBusyAction(null);
    }
  };

  const configureOfflineFallback = async () => {
    if (!bridge) return;
    const directory = await bridge.pickDirectory();
    if (!directory) return;
    setBusyAction("offline-dir");
    try {
      await bridge.setOfflineBackupDir(directory);
      setStartupDismissed(true);
    } finally {
      setBusyAction(null);
    }
  };

  const openCloudCredentialsPanel = () => {
    setTopView("cloud");
    setStartupDismissed(true);
  };

  const openOAuthHelp = () => {
    setOauthHelpImageFailed({});
    setOauthHelpIndex(0);
    setOauthHelpOpen(true);
  };

  const currentHelpSlide = oauthHelpSlides[oauthHelpIndex];
  const currentHelpImageName = currentHelpSlide.imagePath.split("/").pop() || currentHelpSlide.imagePath;
  const currentHelpImageSrc = new URL(currentHelpSlide.imagePath, document.baseURI).toString();

  const openExternalLink = async (href: string) => {
    if (!bridge) return;
    try {
      await bridge.openExternalUrl(href);
    } catch (error) {
      setActivity((current) => [
        {
          type: "warning",
          gameId: null,
          message: error instanceof Error ? error.message : `No se pudo abrir el enlace: ${href}`
        },
        ...current
      ]);
    }
  };

  const renderLibraryContent = () => {
    if (!selectedGame) {
      return <p className="muted-copy">Agrega juegos desde Descubrimiento para poblar la biblioteca.</p>;
    }

    if (libraryTab === "summary") {
      return (
        <div className="steam-content-grid">
          <article className="steam-card steam-feature-card">
            <h4>Resumen del juego</h4>
            <div className="steam-feature-layout">
              <div className="steam-media-tile">{selectedGame.title.slice(0, 1).toUpperCase()}</div>
              <div className="steam-feature-copy">
                <p>Sincroniza saves al cerrar el juego y permite restaurar la ultima copia remota con respaldo temporal previo.</p>
                <div className="steam-actions-row">
                  <button className="play-button" onClick={() => void launchGame(selectedGame.id)} disabled={busyAction === `launch:${selectedGame.id}`}>
                    JUGAR
                  </button>
                  <button className="secondary-button" onClick={() => void restoreLatest(selectedGame.id)} disabled={!selectedGame.latestRemoteSave || busyAction === `restore:${selectedGame.id}`}>
                    Restaurar save
                  </button>
                  <button className="secondary-button" onClick={() => void backupNow(selectedGame.id)} disabled={busyAction === `backup:${selectedGame.id}`}>
                    Respaldar ahora
                  </button>
                </div>
              </div>
            </div>
          </article>

          <article className="steam-card">
            <h4>Estado</h4>
            <div className="steam-stat-list">
              <div><span>Ultima sesion</span><strong>{formatDate(selectedGame.lastPlayedAt)}</strong></div>
              <div><span>Tiempo jugado</span><strong>{formatDuration(getEffectivePlaySeconds(selectedGame))}</strong></div>
              <div><span>Save local</span><strong>{formatDate(selectedGame.latestLocalSave?.createdAt)}</strong></div>
              <div><span>Save remoto</span><strong>{formatDate(selectedGame.latestRemoteSave?.createdAt)}</strong></div>
            </div>
          </article>

          <article className="steam-card steam-card-span">
            <h4>Actividad reciente</h4>
            <div className="steam-feed">
              {selectedActivity.slice(0, 8).map((item, index) => (
                <article className={`steam-feed-item tone-${item.type === "snapshot" ? "success" : item.type}`} key={`${item.message}-${index}`}>
                  <span>{formatDate(item.snapshot?.createdAt || null)}</span>
                  <p>{item.message}</p>
                </article>
              ))}
              {!selectedActivity.length ? <p className="muted-copy">Sin eventos recientes para este juego.</p> : null}
            </div>
          </article>
        </div>
      );
    }

    if (libraryTab === "saves") {
      return (
        <div className="steam-content-grid">
          <article className="steam-card">
            <h4>Save local actual</h4>
            <div className="steam-stat-list">
              <div><span>Fecha</span><strong>{formatDate(selectedGame.latestLocalSave?.createdAt)}</strong></div>
              <div><span>Archivo</span><strong>{selectedGame.latestLocalSave?.archiveName || "Sin snapshot local"}</strong></div>
              <div><span>Tamano</span><strong>{selectedGame.latestLocalSave ? `${Math.round(selectedGame.latestLocalSave.sizeBytes / 1024)} KB` : "Sin datos"}</strong></div>
            </div>
          </article>
          <article className="steam-card">
            <h4>Save remoto actual</h4>
            <div className="steam-stat-list">
              <div><span>Fecha</span><strong>{formatDate(selectedGame.latestRemoteSave?.createdAt)}</strong></div>
              <div><span>Archivo</span><strong>{selectedGame.latestRemoteSave?.archiveName || "Sin backup remoto"}</strong></div>
              <div><span>Equipo</span><strong>{selectedGame.latestRemoteSave?.deviceLabel || "Sin datos"}</strong></div>
            </div>
          </article>
          <article className="steam-card steam-card-span">
            <h4>Acciones de save</h4>
            <div className="steam-actions-row">
              <button className="secondary-button" onClick={startMonitoring} disabled={busyAction === "monitor"}>Empezar monitoreo</button>
              <button className="secondary-button" onClick={() => void restoreLatest(selectedGame.id)} disabled={!selectedGame.latestRemoteSave || busyAction === `restore:${selectedGame.id}`}>Restaurar ultimo remoto</button>
              <button className="secondary-button" onClick={() => void backupNow(selectedGame.id)} disabled={busyAction === `backup:${selectedGame.id}`}>Respaldar manualmente</button>
            </div>
          </article>
        </div>
      );
    }

    if (libraryTab === "paths") {
      return (
        <div className="steam-content-grid">
          <article className="steam-card steam-card-span">
            <h4>Rutas</h4>
            <div className="steam-path-list">
              <div><span>Instalacion</span><strong>{selectedGame.installRoot || "Sin registrar"}</strong></div>
              <div><span>Save path</span><strong>{selectedGame.savePath}</strong></div>
              <div><span>Ejecutable</span><strong>{selectedGame.executablePath || "Sin registrar"}</strong></div>
              <div><span>Launch target</span><strong>{selectedGame.launchTarget || "Sin registrar"}</strong></div>
              <div><span>Patrones</span><strong>{selectedGame.filePatterns.join(", ")}</strong></div>
            </div>
          </article>
        </div>
      );
    }

    return (
      <article className="steam-card steam-card-span">
        <h4>Administrar juego</h4>
        <form className="steam-form" onSubmit={submitEdit}>
          <label><span>Nombre</span><input value={editForm.title} onChange={(e) => updateEdit("title", e.target.value)} required /></label>
          <label><span>Proceso</span><input value={editForm.processName} onChange={(e) => updateEdit("processName", e.target.value)} required /></label>
          <label>
            <span>Ruta de save</span>
            <div className="field-with-action">
              <input value={editForm.savePath} onChange={(e) => updateEdit("savePath", e.target.value)} required />
              <button className="mini-button" type="button" onClick={() => void pickDirectoryInto("savePath", "edit")}>Elegir</button>
            </div>
          </label>
          <label><span>Ejecutable</span><input value={editForm.executablePath} onChange={(e) => updateEdit("executablePath", e.target.value)} /></label>
          <label><span>Instalacion</span><input value={editForm.installRoot} onChange={(e) => updateEdit("installRoot", e.target.value)} /></label>
          <label>
            <span>Tipo de lanzamiento</span>
            <select value={editForm.launchType} onChange={(e) => updateEdit("launchType", e.target.value)}>
              <option value="exe">EXE</option>
              <option value="steam">Steam</option>
              <option value="uri">URI</option>
              <option value="command">Comando</option>
            </select>
          </label>
          <label><span>{launchHelp(editForm.launchType)}</span><input value={editForm.launchTarget} onChange={(e) => updateEdit("launchTarget", e.target.value)} /></label>
          <label><span>Patrones</span><input value={editForm.filePatterns} onChange={(e) => updateEdit("filePatterns", e.target.value)} /></label>
          <button className="secondary-button" type="submit" disabled={busyAction === "edit"}>Guardar cambios</button>
        </form>
      </article>
    );
  };

  const renderMainPanel = () => {
    if (topView === "discovery") {
      return (
        <>
          <section className="steam-section-head">
            <div>
              <span className="section-kicker">Descubrimiento</span>
              <h2>Escaneo de roots y alta manual</h2>
            </div>
            <button className="secondary-button" onClick={scanForGames} disabled={busyAction === "scan" || bootstrap?.runtime.discoveryRunning}>
              {bootstrap?.runtime.discoveryRunning ? "Escaneando..." : "Escanear roots"}
            </button>
          </section>

          <div className="steam-content-grid discovery-layout">
            <article className="steam-card">
              <h4>Roots</h4>
              <div className="steam-form">
                <label>
                  <span>Nueva root</span>
                  <div className="field-with-action">
                    <input value={newRoot} onChange={(e) => setNewRoot(e.target.value)} placeholder="D:\\SteamLibrary" />
                    <button className="mini-button" type="button" onClick={() => void bridge?.pickDirectory().then((dir) => dir && setNewRoot(dir))}>Elegir</button>
                  </div>
                </label>
                <button className="secondary-button" onClick={addScanRoot} disabled={busyAction === "add-root"}>Agregar root</button>
              </div>
              <div className="steam-list">
                {scanRoots.map((root) => (
                  <div className="steam-list-row" key={root}>
                    <strong>{root}</strong>
                    <button className="mini-button" onClick={() => void bridge?.removeScanRoot(root)}>Quitar</button>
                  </div>
                ))}
                {!scanRoots.length ? <p className="muted-copy">Todavia no hay directorios agregados.</p> : null}
              </div>
            </article>

            <article className="steam-card">
              <h4>Candidatos</h4>
              {discoveryStatus ? (
                <p className="muted-copy">
                  {discoveryStatus.phase} - {discoveryStatus.rootIndex}/{discoveryStatus.rootCount} roots - {discoveryStatus.processedExecutables} ejecutables
                </p>
              ) : null}
              <div className="steam-feed">
                {discoveryCandidates.map((candidate) => (
                  <article className="steam-feed-item" key={candidate.id}>
                    <span>{candidate.processName}</span>
                    <p>{candidate.title}</p>
                    <small>{candidate.suggestedSavePath}</small>
                    <button className="mini-button" onClick={() => void importCandidate(candidate)} disabled={busyAction === `import:${candidate.id}`}>Importar</button>
                  </article>
                ))}
                {!discoveryCandidates.length ? <p className="muted-copy">No hay candidatos en memoria.</p> : null}
              </div>
            </article>

            <article className="steam-card">
              <h4>Alta manual</h4>
              <form className="steam-form" onSubmit={submitManualGame}>
                <label><span>Nombre</span><input value={manualForm.title} onChange={(e) => updateManual("title", e.target.value)} required /></label>
                <label><span>Proceso</span><input value={manualForm.processName} onChange={(e) => updateManual("processName", e.target.value)} required /></label>
                <label>
                  <span>Ruta de save</span>
                  <div className="field-with-action">
                    <input value={manualForm.savePath} onChange={(e) => updateManual("savePath", e.target.value)} required />
                    <button className="mini-button" type="button" onClick={() => void pickDirectoryInto("savePath", "manual")}>Elegir</button>
                  </div>
                </label>
                <label><span>Ejecutable</span><input value={manualForm.executablePath} onChange={(e) => updateManual("executablePath", e.target.value)} /></label>
                <label><span>Instalacion</span><input value={manualForm.installRoot} onChange={(e) => updateManual("installRoot", e.target.value)} /></label>
                <label>
                  <span>Tipo de lanzamiento</span>
                  <select value={manualForm.launchType} onChange={(e) => updateManual("launchType", e.target.value)}>
                    <option value="exe">EXE</option>
                    <option value="steam">Steam</option>
                    <option value="uri">URI</option>
                    <option value="command">Comando</option>
                  </select>
                </label>
                <label><span>{launchHelp(manualForm.launchType)}</span><input value={manualForm.launchTarget} onChange={(e) => updateManual("launchTarget", e.target.value)} /></label>
                <label><span>Patrones</span><input value={manualForm.filePatterns} onChange={(e) => updateManual("filePatterns", e.target.value)} /></label>
                <button className="secondary-button" type="submit" disabled={busyAction === "manual"}>Guardar juego</button>
              </form>
            </article>
          </div>
        </>
      );
    }

    if (topView === "cloud") {
      return (
        <>
          <section className="steam-section-head">
            <div>
              <span className="section-kicker">Nube</span>
              <h2>Google Drive y catalogo remoto</h2>
            </div>
            <button className="secondary-button" onClick={connectGoogle} disabled={busyAction === "google"}>
              {bootstrap?.capabilities.googleAuthenticated ? "Cuenta conectada" : "Conectar con Google"}
            </button>
          </section>
          <div className="steam-content-grid">
            <article className="steam-card">
              <h4>Estado</h4>
              <div className="steam-stat-list">
                <div><span>Cuenta</span><strong>{bootstrap?.capabilities.googleAuthenticated ? "Conectada" : "Pendiente"}</strong></div>
                <div><span>Carpeta raiz</span><strong>{bootstrap?.env.driveRootFolderName}</strong></div>
                <div><span>Saves remotos</span><strong>{totals.remote}</strong></div>
                <div><span>Fallback local</span><strong>{bootstrap?.env.offlineBackupDir || "No configurado"}</strong></div>
              </div>
            </article>
            <article className="steam-card">
              <h4>Credenciales OAuth</h4>
              <form className="steam-form" onSubmit={saveGoogleOAuth}>
                <label>
                  <span>Client ID</span>
                  <input
                    value={oauthForm.clientId}
                    onChange={(e) => setOauthForm((current) => ({ ...current, clientId: e.target.value }))}
                    placeholder="Tu Google OAuth Client ID"
                    required
                  />
                  <small className="field-help">
                    Es el identificador publico de tu cliente OAuth. Google lo muestra cuando terminas de crear el cliente.
                  </small>
                </label>
                <label>
                  <span>Client Secret</span>
                  <input
                    type="password"
                    value={oauthForm.clientSecret}
                    onChange={(e) => setOauthForm((current) => ({ ...current, clientSecret: e.target.value }))}
                    placeholder="Tu Google OAuth Client Secret"
                    required
                  />
                  <small className="field-help">
                    Es la clave privada del cliente. Copiala al crear el cliente y no la publiques en Git ni en capturas.
                  </small>
                </label>
                <label>
                  <span>Redirect URI</span>
                  <input
                    value={oauthForm.redirectUri}
                    onChange={(e) => setOauthForm((current) => ({ ...current, redirectUri: e.target.value }))}
                    placeholder="http://127.0.0.1:42813/oauth2/callback"
                    required
                  />
                  <small className="field-help">
                    Para SincGames usa este valor local. Debe coincidir exactamente con el valor esperado por la app cuando haces login.
                  </small>
                </label>
                <div className="help-tip oauth-fields-tip">
                  <span>Que hace cada campo</span>
                  <strong>Client ID identifica la app, Client Secret autoriza la app y Redirect URI recibe el retorno del login.</strong>
                  <p className="muted-copy">
                    Si copias mal alguno de estos tres valores, Google devolvera errores como <code>redirect_uri_mismatch</code> o bloqueo de acceso.
                  </p>
                </div>
                <button className="secondary-button" type="submit" disabled={busyAction === "oauth-save"}>
                  Guardar credenciales
                </button>
                <button className="mini-button" type="button" onClick={openOAuthHelp}>
                  Ayuda paso a paso
                </button>
                {oauthNotice ? <p className="success-copy">{oauthNotice}</p> : null}
              </form>
            </article>
            <article className="steam-card steam-card-span">
              <h4>Politica</h4>
              <div className="steam-path-list">
                <div><span>Subida</span><strong>Se comprime el save cuando el juego ya esta cerrado y hubo cambios.</strong></div>
                <div><span>Restauracion</span><strong>Se crea un backup temporal local antes de sobrescribir.</strong></div>
                <div><span>Catalogo</span><strong>Rutas y metadata de juegos viven en Drive para evitar perdida por formateo.</strong></div>
                <div><span>Archivo local</span><strong>{bootstrap?.env.oauthConfigPath}</strong></div>
              </div>
              <div className="steam-actions-row">
                <button className="secondary-button" onClick={connectGoogle} disabled={busyAction === "google"}>Conectar Google</button>
                <button className="secondary-button" onClick={configureOfflineFallback} disabled={busyAction === "offline-dir"}>Elegir carpeta local</button>
              </div>
            </article>
          </div>
        </>
      );
    }

    if (topView === "activity") {
      return (
        <>
          <section className="steam-section-head">
            <div>
              <span className="section-kicker">Actividad</span>
              <h2>Bitacora del sistema</h2>
            </div>
          </section>
          <article className="steam-card">
            <div className="steam-feed">
              {activity.map((item, index) => (
                <article className={`steam-feed-item tone-${item.type === "snapshot" ? "success" : item.type}`} key={`${item.message}-${index}`}>
                  <span>{item.gameId || "global"}</span>
                  <p>{item.message}</p>
                </article>
              ))}
              {!activity.length ? <p className="muted-copy">Todavia no hay eventos.</p> : null}
            </div>
          </article>
        </>
      );
    }

    return (
      <>
        <section className="game-hero">
          <div className="game-hero-backdrop" />
          <div className="game-hero-content">
            <div className="game-hero-copy">
              <span className="section-kicker">Biblioteca</span>
              <h2>{selectedGame?.title || "Sin seleccion"}</h2>
              <p>{selectedGame ? `${selectedGame.processName} - doble click en la lista izquierda para iniciar.` : "Selecciona un juego para ver detalle."}</p>
            </div>
            <div className="game-hero-metrics">
              <div><span>Ultima sesion</span><strong>{formatDate(selectedGame?.lastPlayedAt)}</strong></div>
              <div><span>Tiempo jugado</span><strong>{formatDuration(getEffectivePlaySeconds(selectedGame))}</strong></div>
              <div><span>Estado cloud</span><strong>{selectedGame?.latestRemoteSave ? "Actualizado" : "Pendiente"}</strong></div>
            </div>
          </div>
        </section>

        <section className="steam-action-bar">
          <button className="play-button" onClick={() => selectedGame && void launchGame(selectedGame.id)} disabled={!selectedGame || busyAction === `launch:${selectedGame?.id}`}>
            JUGAR
          </button>
          <button className="secondary-button" onClick={() => selectedGame && void backupNow(selectedGame.id)} disabled={!selectedGame || busyAction === `backup:${selectedGame?.id}`}>
            Respaldar ahora
          </button>
          <div className="action-status">
            <span>Monitoreo</span>
            <strong>{bootstrap?.runtime.monitoringStarted ? "Activo" : "Detenido"}</strong>
          </div>
          <div className="action-status">
            <span>Ultimo save</span>
            <strong>{formatDate(selectedGame?.latestLocalSave?.createdAt)}</strong>
          </div>
          <div className="action-status">
            <span>Tiempo de juego</span>
            <strong>{formatDuration(getEffectivePlaySeconds(selectedGame))}</strong>
          </div>
        </section>

        <section className="steam-subnav">
          {[
            { id: "summary", label: "Resumen" },
            { id: "saves", label: "Saves" },
            { id: "paths", label: "Rutas" },
            { id: "manage", label: "Administrar" }
          ].map((item) => (
            <button key={item.id} className={`steam-subnav-item ${libraryTab === item.id ? "active" : ""}`} onClick={() => setLibraryTab(item.id as LibraryTab)}>
              {item.label}
            </button>
          ))}
        </section>

        {renderLibraryContent()}
      </>
    );
  };

  return (
    <main className="steam-shell">
      <header className="steam-topbar">
        <div className="steam-brand">
          <strong>{bootstrap?.env.appName || "SincGames"}</strong>
          <span>Launcher + Save Sync</span>
        </div>
        <nav className="steam-topnav">
          {[
            { id: "library", label: "BIBLIOTECA" },
            { id: "discovery", label: "DESCUBRIMIENTO" },
            { id: "cloud", label: "NUBE" },
            { id: "activity", label: "ACTIVIDAD" }
          ].map((item) => (
            <button key={item.id} className={`steam-topnav-item ${topView === item.id ? "active" : ""}`} onClick={() => setTopView(item.id as TopView)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="steam-topbar-status">
          <span>{bootstrap?.capabilities.googleAuthenticated ? "Drive conectado" : "Drive pendiente"}</span>
          <button className="tiny-button" onClick={connectGoogle}>Cuenta</button>
        </div>
      </header>

      <section className="steam-body">
        <aside className="steam-sidebar">
          <div className="steam-sidebar-top">
            <div className="steam-sidebar-filter">
              <input value={libraryFilter} onChange={(e) => setLibraryFilter(e.target.value)} placeholder="Buscar en biblioteca" />
            </div>
            <div className="steam-sidebar-links">
              <button className={`steam-mini-nav ${topView === "library" ? "active" : ""}`} onClick={() => setTopView("library")}>Juegos</button>
              <button className={`steam-mini-nav ${topView === "discovery" ? "active" : ""}`} onClick={() => setTopView("discovery")}>Escaneo</button>
            </div>
          </div>

          <div className="steam-library-list">
            {filteredGames.map((game) => (
              <button
                key={game.id}
                className={`steam-library-row ${selectedGame?.id === game.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedGameId(game.id);
                  setTopView("library");
                }}
                onDoubleClick={() => void launchGame(game.id)}
              >
                <div className="steam-library-icon">{game.title.slice(0, 1).toUpperCase()}</div>
                <div className="steam-library-copy">
                  <strong>{game.title}</strong>
                  <span>{game.currentlyRunning ? `En ejecucion · ${formatDuration(getEffectivePlaySeconds(game))}` : formatDuration(getEffectivePlaySeconds(game))}</span>
                </div>
              </button>
            ))}
            {!filteredGames.length ? <p className="muted-copy">No hay juegos que coincidan con la busqueda.</p> : null}
          </div>

          <div className="steam-sidebar-footer">
            <button className="secondary-button" onClick={startMonitoring} disabled={busyAction === "monitor"}>Empezar monitoreo</button>
            <div className="sidebar-footer-stats">
              <span>{totals.games} juegos</span>
              <span>{totals.remote} backups remotos</span>
            </div>
          </div>
        </aside>

        <section className="steam-main">{renderMainPanel()}</section>

        <aside className="steam-rail">
          <article className="steam-card">
            <h4>Estado del sistema</h4>
            <div className="steam-stat-list">
              <div><span>Google Drive</span><strong>{bootstrap?.capabilities.googleAuthenticated ? "Conectado" : "Pendiente"}</strong></div>
              <div><span>Monitoreo</span><strong>{bootstrap?.runtime.monitoringStarted ? "Activo" : "Detenido"}</strong></div>
              <div><span>Escaneo</span><strong>{bootstrap?.runtime.discoveryRunning ? "En curso" : "Libre"}</strong></div>
              <div><span>Tiempo total</span><strong>{formatDuration(totals.time)}</strong></div>
            </div>
          </article>

          <article className="steam-card">
            <h4>Juego seleccionado</h4>
            {selectedGame ? (
              <div className="steam-stat-list">
                <div><span>Proceso</span><strong>{selectedGame.processName}</strong></div>
                <div><span>Save path</span><strong>{selectedGame.savePath}</strong></div>
                <div><span>Cloud</span><strong>{selectedGame.latestRemoteSave ? "Con backup" : "Sin backup"}</strong></div>
              </div>
            ) : (
              <p className="muted-copy">Sin juego seleccionado.</p>
            )}
          </article>

          <article className="steam-card">
            <h4>Resumen general</h4>
            <div className="steam-stat-list">
              <div><span>Juegos</span><strong>{totals.games}</strong></div>
              <div><span>Saves locales</span><strong>{totals.local}</strong></div>
              <div><span>Saves remotos</span><strong>{totals.remote}</strong></div>
            </div>
          </article>
        </aside>
      </section>

      {showStartupOverlay ? (
        <section className="startup-overlay">
          <article className="startup-card">
            <span className="section-kicker">Configuracion inicial</span>
            <h3>Conecta Google o elige un respaldo local antes de seguir.</h3>
            <p className="muted-copy">
              Si conectas Google Drive, la app escanea tu cuenta, restaura la biblioteca respaldada y actualiza la configuracion.
              Si no quieres conectarla ahora, configura una carpeta local para usarla como fallback de backups.
            </p>
            <div className="steam-actions-row">
              {!bootstrap?.capabilities.googleConfigured ? (
                <>
                  <button className="secondary-button" onClick={openCloudCredentialsPanel}>
                    Configurar credenciales
                  </button>
                  <button className="secondary-button" onClick={openOAuthHelp}>
                    Ayuda
                  </button>
                </>
              ) : null}
              <button className="play-button" onClick={connectGoogle} disabled={busyAction === "google"}>
                Conectar Google
              </button>
              <button className="secondary-button" onClick={configureOfflineFallback} disabled={busyAction === "offline-dir"}>
                Elegir carpeta local
              </button>
            </div>
            <div className="startup-hints">
              <span>Google: restaura catalogo y backups remotos.</span>
              <span>Fallback local: guarda ZIPs y catalogo en la carpeta elegida.</span>
            </div>
          </article>
        </section>
      ) : null}

      {oauthHelpOpen ? (
        <section className="help-overlay" onClick={() => setOauthHelpOpen(false)}>
          <article className="help-modal" onClick={(event) => event.stopPropagation()}>
            <header className="help-header">
              <div>
                <span className="section-kicker">Ayuda OAuth</span>
                <h3>{currentHelpSlide.title}</h3>
              </div>
              <button className="tiny-button" onClick={() => setOauthHelpOpen(false)}>
                Cerrar
              </button>
            </header>

            <div className="help-progress">
              <strong>
                Paso {oauthHelpIndex + 1} de {oauthHelpSlides.length}
              </strong>
              <div className="help-progress-bar">
                <span style={{ width: `${((oauthHelpIndex + 1) / oauthHelpSlides.length) * 100}%` }} />
              </div>
            </div>

            <div className="help-layout">
              <section className="help-copy">
                <p>{currentHelpSlide.body}</p>

                <div className="help-links">
                  {currentHelpSlide.links.map((link) => (
                    <button key={link.href} className="secondary-button help-link" type="button" onClick={() => void openExternalLink(link.href)}>
                      {link.label}
                    </button>
                  ))}
                  {!currentHelpSlide.links.length ? (
                    <p className="muted-copy">Este paso no requiere enlaces extra; usa la captura como referencia.</p>
                  ) : null}
                </div>

                <div className="help-tip">
                  <span>Captura esperada</span>
                  <strong>{currentHelpImageName}</strong>
                  <p className="muted-copy">Esta guia usa una captura de referencia para mostrar exactamente donde debes dar click.</p>
                </div>
              </section>

              <section className="help-visual">
                {!oauthHelpImageFailed[oauthHelpIndex] ? (
                  <img
                    key={currentHelpImageSrc}
                    src={currentHelpImageSrc}
                    alt={currentHelpSlide.title}
                    onLoad={() =>
                      setOauthHelpImageFailed((current) => {
                        if (!current[oauthHelpIndex]) return current;
                        const next = { ...current };
                        delete next[oauthHelpIndex];
                        return next;
                      })
                    }
                    onError={() =>
                      setOauthHelpImageFailed((current) => ({
                        ...current,
                        [oauthHelpIndex]: true
                      }))
                    }
                  />
                ) : null}

                {oauthHelpImageFailed[oauthHelpIndex] ? (
                  <div className="help-image-placeholder">
                    <strong>No se pudo cargar la captura de este paso</strong>
                    <span>{currentHelpImageName}</span>
                    <p>Reinicia la app o actualiza la instalacion para volver a cargar las imagenes de ayuda.</p>
                  </div>
                ) : null}
              </section>
            </div>

            <footer className="help-footer">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setOauthHelpIndex((current) => Math.max(0, current - 1))}
                disabled={oauthHelpIndex === 0}
              >
                Anterior
              </button>
              <button
                className="play-button help-next"
                type="button"
                onClick={() => {
                  if (oauthHelpIndex === oauthHelpSlides.length - 1) {
                    setOauthHelpOpen(false);
                    setTopView("cloud");
                    setStartupDismissed(true);
                    return;
                  }
                  setOauthHelpIndex((current) => Math.min(oauthHelpSlides.length - 1, current + 1));
                }}
              >
                {oauthHelpIndex === oauthHelpSlides.length - 1 ? "Ir a Nube" : "Siguiente"}
              </button>
            </footer>
          </article>
        </section>
      ) : null}
    </main>
  );
}

export default App;
