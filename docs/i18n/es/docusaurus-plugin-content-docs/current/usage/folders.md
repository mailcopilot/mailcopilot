---
sidebar_position: 4
title: Carpetas
---

# Carpetas

## Navegacion

Haz clic en una carpeta en la barra lateral. Atajos: **g** luego **i** (Bandeja de entrada), **g** luego **s** (Enviados), **g** luego **d** (Borradores), **g** luego __*__ (Destacados).
- **g** y luego **r** — ir a «Leer más tarde»

## Carpetas especiales

MailCopilot reconoce las siguientes carpetas especiales:

| Carpeta | Descripcion |
|---------|-------------|
| **Bandeja de entrada** | Tus mensajes entrantes. |
| **Enviados** | Mensajes que has enviado. |
| **Borradores** | Borradores de mensajes no enviados. |
| **Papelera** | Mensajes eliminados. Desde aqui se pueden eliminar permanentemente. |
| **Spam** | Mensajes marcados como spam. |
| **Archivo** | Mensajes archivados que quieres conservar fuera de la bandeja de entrada. |
| **Bandeja de salida** | Mensajes programados para envio diferido o programado. |
| **Pospuestos** | Mensajes que has pospuesto. Reapareceran cuando expire el tiempo de aplazamiento. |
| **Seguimiento** | Correos con recordatorios de seguimiento pendientes de respuesta. |
| **Leer más tarde** | Correos marcados para leer después. A diferencia de los pospuestos, permanecen en su carpeta original. |

MailCopilot detecta automaticamente que carpeta del servidor corresponde a cada rol especial. Puedes cambiar esta asignacion en **Configuracion > Carpetas** si es necesario.

## Mover mensajes

Arrastrar y soltar, menu contextual, tecla **v** o botones de accion.

## Menu contextual de carpeta

Haga clic derecho en una carpeta de la barra lateral para acceder a las opciones:

- **Sincronizar todos los encabezados** / **Sincronizar al abrir** -- controla la sincronización de encabezados.
- **Incluir en la búsqueda** / **Excluir de la búsqueda** -- activa o desactiva la indexación del cuerpo de los mensajes para la búsqueda de texto completo (`body:`). Desactivado de forma predeterminada para las carpetas de correo no deseado, Spam y Papelera.
- **Mostrar/Ocultar en insignias de no leídos** -- incluir o no en la insignia total.
- **Mostrar/Ocultar en la barra lateral** -- controlar la visibilidad.
- **Cambiar icono** -- establecer un emoji o icono personalizado.
- **Renombrar carpeta** -- renombrar en el servidor.
- **Eliminar carpeta** -- eliminar del servidor (requiere confirmación).

## Insignias de no leídos

Cada carpeta muestra una insignia con el número de mensajes no leídos. Los mensajes pospuestos se excluyen automáticamente de estos conteos — no inflarán tus insignias de no leídos mientras estén pospuestos.

Puedes personalizar qué carpetas muestran insignias de no leídos:

- Haz clic derecho en una carpeta y selecciona **Mostrar en insignias de no leídos** u **Ocultar de insignias de no leídos**.
- O configúralo en **Configuración > Carpetas** en la política de sincronización de carpetas.

## Eliminacion permanente

Eliminar desde la Papelera es permanente. Aparece un dialogo de confirmacion.
