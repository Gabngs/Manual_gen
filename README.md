# Manual Gen

Genera el manual de usuario de un formulario Angular y lo publica en BookStack:

1. Lee el código del componente desde una rama de git (`git show`, sin cambiar de rama).
2. Abre la aplicación (Dev) con Chrome/Edge, inicia sesión y toma capturas (pantalla y ventanas emergentes; nunca guarda nada).
3. Redacta el texto con **Claude Code** (opcional) o con **plantillas**.
4. Muestra una **vista previa**; solo al pulsar *Publicar* se escribe en BookStack.

## Uso

**Descarga** `ManualGen.exe` desde [Releases](../../releases) y ábrelo. Se abre la interfaz en `http://localhost:4317`.
Los datos (configuración, capturas) se guardan junto al .exe en `data/` y `out/`.

Requisitos en el equipo: Chrome o Edge, y `git` con acceso al repo del código (clonado localmente).

### Claude (opcional)
- Pulsa **Iniciar sesión con Claude**. Necesita [Claude Code](https://claude.com/claude-code) instalado.
- La sesión es **temporal y aislada**: vive en una carpeta propia que se borra al cerrar el programa. Nunca usa la sesión de Claude Code que ya tengas en tu equipo.
- Sin sesión (o sin Claude Code) se usan **plantillas**.

### Configuración
- **Repositorio**: ruta local del clon y rama (`origin/develop`).
- **Entornos**: URL + usuario/contraseña para las capturas (puedes registrar varios).
- **BookStack**: URL + Token ID/Secret (Perfil → Tokens de API; el rol necesita «Acceder a la API del sistema»).
- **Manuales**: cada formulario (ruta, componente, libro/capítulo y ventanas a capturar).

## Desarrollo
```
npm install
npm start          # http://localhost:4317
npm run build      # genera dist/ManualGen.exe (esbuild + Node SEA)
```
Para publicar una versión: `git tag v1.0.0 && git push --tags` (GitHub Actions compila y adjunta el .exe al Release).

> Las credenciales se guardan en texto plano en `data/settings.json` (excluido de git). No compartas esa carpeta.
