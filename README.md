# Manual Gen

Genera el manual de usuario de un formulario Angular y lo publica en BookStack:

1. Lee el código del componente desde una rama de git (`git show`, sin cambiar de rama).
2. Abre la aplicación (Dev) con Chrome/Edge, inicia sesión y toma capturas (pantalla y ventanas emergentes; nunca guarda nada).
3. Redacta el texto con **Claude Code** (opcional) o con **plantillas**.
4. Muestra una **vista previa**; solo al pulsar *Publicar* se escribe en BookStack.

## Uso

**Descarga** `ManualGen.exe` desde [Releases](../../releases) y ábrelo. Se abre la interfaz en `http://localhost:4317`.
La configuración se guarda en `%APPDATA%\ManualGen\`, **cifrada con DPAPI de Windows** (ligada a tu usuario y a tu equipo: copiar el archivo a otra PC no sirve). Está fuera del .exe, así que sobrevive a las actualizaciones. Si existía una carpeta `data/` de una versión anterior junto al .exe, se migra sola y se borra la copia en texto plano.

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

> Límite: quien use tu mismo usuario de Windows con la sesión iniciada puede ejecutar la app (necesita descifrar para trabajar). El cifrado evita que se copie el archivo a otro equipo o usuario.
