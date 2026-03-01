# SincGames

Aplicacion de escritorio para Windows orientada a detectar cambios en partidas guardadas, empaquetarlas y sincronizarlas con Google Drive cuando el juego ya esta cerrado.

## Stack elegido

- Electron para acceso a sistema de archivos, procesos, dialogs y empaquetado de escritorio.
- React + TypeScript para una UI moderna y dinamica.
- Google Drive API como backend de almacenamiento y catalogo remoto.
- Manifest externo de juegos para sugerir rutas de guardado durante la autodeteccion.

## Lo que ya hace esta base

- inicializa `git` local;
- expone `.env` y `.env.example`;
- permite agregar roots de escaneo desde la interfaz;
- busca `.exe` en directorios elegidos por el usuario;
- consulta un manifest externo para sugerir rutas de save;
- registra juegos manualmente desde la interfaz;
- monitorea carpetas de save y espera a que el proceso del juego se cierre;
- comprime el save en ZIP;
- sube backups y catalogo a Google Drive cuando hay sesion activa;
- restaura backups remotos creando primero un backup temporal local;
- limpia backups temporales viejos automaticamente.

## Variables de entorno

Configura estas variables en `.env`:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_DRIVE_ROOT_FOLDER_NAME`
- `GAME_MANIFEST_URL`
- `DEVICE_LABEL`
- `TEMP_BACKUP_RETENTION_DAYS`
- `DISCOVERY_SCAN_DEPTH`

## Build empaquetado

Las releases publicas no incluyen tus credenciales reales de Google.

Para que el portable o el instalador puedan usar Drive:

1. coloca un archivo `.env` junto al `.exe` de `SincGames`;
2. puedes partir de `.env.example`;
3. llena al menos:
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REDIRECT_URI`

## Modelo remoto previsto

- `/library/games.json`
- `/backups/{gameId}/snapshots/*.zip`
- `/backups/{gameId}/metadata/*.json`
- `/backups/{gameId}/latest.json`

## Falta por completar

- persistencia segura de tokens OAuth entre reinicios;
- deteccion mas avanzada de conflictos y flujo UI para "guardar ambos";
- comparacion y descarga automatica al iniciar en otra instancia;
- empaquetado instalable para distribucion.

## Arranque esperado

Cuando tengas acceso a red para instalar paquetes:

```powershell
npm install
npm run dev
```
