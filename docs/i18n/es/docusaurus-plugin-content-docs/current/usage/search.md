---
sidebar_position: 5
---

# Buscar

MailCopilot ofrece potentes capacidades de búsqueda para encontrar cualquier correo en todas sus cuentas y carpetas.

## Búsqueda simple

Escriba en la barra de búsqueda en la parte superior de la lista de correos. Los resultados aparecen instantáneamente.

## Alcance de búsqueda

Al buscar, puede elegir el alcance con los botones debajo de la barra de búsqueda:

- **Carpeta actual** — buscar solo en la carpeta que está viendo.
- **Todas las carpetas** — buscar en todas las carpetas de la cuenta actual.
- **Todas las cuentas** — buscar en todas las cuentas y carpetas conectadas.

## Operadores de búsqueda

Use operadores para búsquedas precisas:

| Operador | Descripción | Ejemplo |
|----------|-------------|---------|
| `from:` | Por remitente | `from:alice@example.com` |
| `to:` | Por destinatario | `to:bob@example.com` |
| `subject:` | Por asunto | `subject:reunión` |
| `body:` | Por contenido | `body:factura` |
| `filename:` | Por archivo adjunto | `filename:informe.pdf` |
| `is:unread` | No leídos | `is:unread` |
| `is:starred` | Destacados | `is:starred` |
| `has:attachment` | Con archivos adjuntos | `has:attachment` |
| `before:` | Antes de una fecha | `before:2026-01-01` |
| `after:` | Después de una fecha | `after:2025-12-01` |

Combine operadores con texto libre: `from:alice subject:informe is:unread`.

Use `-` para excluir: `-from:spam@example.com`.

## Completitud de la búsqueda

MailCopilot busca en su caché local de correos. El indicador de completitud muestra:

- **Cobertura de encabezados** — cuántas carpetas están sincronizadas (ej. «Encabezados: 5/8 carpetas»).
- **Indexación de texto** — porcentaje de mensajes con texto indexado para búsquedas `body:`.

Las carpetas estándar (Bandeja de entrada, Enviados, Archivo, Borradores) se indexan completamente por defecto. Las carpetas de correo no deseado, Spam y Papelera están excluidas de la indexación de texto completo de forma predeterminada para mantener los resultados de búsqueda limpios y reducir el uso del disco. Puede cambiar la configuración de indexación de cualquier carpeta haciendo clic derecho en la barra lateral o en **Configuración > Carpetas**.

Un mensaje que se abrió con normalidad -- incluido uno cuyo cuerpo se recortó por el [límite flexible de 1 MB](../usage/reading-emails#mensajes-muy-grandes) -- se puede buscar de inmediato con `body:`, como cualquier otro mensaje: se indexan los primeros aproximadamente 200 000 caracteres de su cuerpo. Un mensaje que supera el límite estricto de 100 MB (véase la misma sección) es diferente: como su cuerpo nunca se decodificó al abrirlo, la búsqueda con `body:` solo empieza a encontrarlo una vez que el indexador de cuerpos en segundo plano lo recupera e indexa desde el servidor, lo que puede tardar más que con un mensaje normal.

## Búsqueda asistida por servidor

Al buscar en una carpeta específica, MailCopilot puede consultar el servidor IMAP. Los resultados del servidor se marcan con «+N del servidor».

## Clasificación por relevancia

Los resultados se clasifican por relevancia. Las coincidencias en el asunto se clasifican más alto que las del cuerpo del mensaje.

## Preguntar al asistente de IA sobre tu correo

La búsqueda encuentra mensajes. Si prefieres hacer una pregunta con tus propias palabras, usa el asistente de IA: abre el panel del chat de IA desde la barra lateral.

- **Misma caché e índice.** Cuando el asistente busca en tu correo, usa la caché local y el índice de búsqueda descritos en esta página, así que todo lo de [Completitud de la búsqueda](#completitud-de-la-búsqueda) se aplica también a sus respuestas: un mensaje que todavía no está indexado puede pasarse por alto. Si el índice de un buzón consultado aún está incompleto, una línea bajo la respuesta lo indica.

Cómo funciona el asistente, qué envía a tu proveedor de IA y cómo marca los enlaces a mensajes que no recibió se describe en [Asistente de IA](../ai-assistant#abrir-el-panel-ia).
