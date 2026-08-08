---
sidebar_position: 2
title: Leer correos
---

# Leer correos

## Ver un mensaje

Haz clic en un mensaje para abrirlo. Teclado: **j**/**k** (siguiente/anterior), **o** o **Enter** (abrir), **u** (volver).

## Encabezados de destinatarios

El panel de lectura muestra los campos **To**, **Cc** y (para los mensajes enviados) **Bcc** sobre el cuerpo del mensaje. Cuando un campo contiene más de tres direcciones, MailCopilot colapsa el excedente: los tres primeros nombres se muestran en línea, seguidos de un botón **+N más**, donde N es el número de direcciones ocultas.

Haga clic en **+N más** para expandir la lista completa de destinatarios en varias líneas. Haga clic de nuevo en el botón para volver a la vista resumida. También puede pulsar **Esc** con la lista expandida para colapsarla.

Coloque el cursor sobre el nombre de un destinatario para ver una información emergente con la cadena completa `Nombre <email@host>`. Los usuarios del teclado pueden navegar con Tab hasta cada chip de destinatario y el botón **+N más**; pulsar **Intro** o **Espacio** en el botón alterna el estado expandido.

**Privacidad de Bcc:** la fila Bcc solo se muestra en los mensajes que usted mismo ha enviado. Nunca se muestra en los mensajes recibidos, por lo que los destinatarios Bcc de los mensajes entrantes permanecen privados.

## Imagenes externas

Bloqueadas por defecto. Haz clic en **Mostrar imagenes** o activa la opcion en Configuracion.

## Texto citado

Cuando recibe una respuesta o un mensaje reenviado, MailCopilot colapsa automáticamente el historial citado para que solo vea el contenido nuevo. La parte citada queda oculta detrás de un control **Mostrar texto citado** al final del cuerpo del mensaje.

Haga clic en **Mostrar texto citado** para expandir el historial completo directamente en el mensaje. El colapso de citas se aplica **únicamente a los correos HTML**: los bloques `<blockquote>` de nivel superior y anidados se pliegan cada uno de forma independiente mediante un elemento nativo `<details>`/`<summary>` — no se requiere JavaScript. MailCopilot también detecta patrones de atribución al estilo Outlook (`-----Original Message-----`, `On … wrote:`) cuando preceden inmediatamente a un bloque `<blockquote>`, y pliega esas líneas de atribución junto con el bloque citado correspondiente.

Los correos en texto plano muestran el historial de citas tal cual, sin colapso. Esta es una limitación conocida que está previsto corregir en una versión futura.

Si el mensaje no contiene texto citado, el control no aparece.

## Hilos de conversación

Cuando el agrupamiento por conversaciones está activado (opción predeterminada), los mensajes relacionados se agrupan en hilos. En la lista de mensajes, los hilos con más de un mensaje muestran un distintivo `+N` junto al asunto — indica cuántos mensajes adicionales hay en el hilo; la información emergente muestra el total. Haga clic en el hilo de la lista de mensajes para abrirlo en el panel de lectura.

### Vista del hilo — pila de tarjetas

Los hilos con dos o más mensajes se muestran como una pila vertical de tarjetas. De forma predeterminada, las tarjetas están ordenadas de **más reciente a más antigua**. El mensaje más reciente — el último recibido — es la tarjeta activa expandida; los mensajes más antiguos están contraídos debajo de él.

- Las **tarjetas contraídas** muestran el avatar del remitente, su nombre, la fecha en formato inteligente y un breve fragmento de texto. Si el mensaje no tiene texto previsualizable, la tarjeta muestra **«(sin vista previa)»**.
- Haga clic en cualquier tarjeta contraída para expandirla. Haga clic de nuevo en una tarjeta expandida para contraerla. Solo puede haber una tarjeta expandida a la vez: abrir otro mensaje cierra el anterior.

Los hilos de un solo mensaje y las cuentas con el agrupamiento desactivado siguen utilizando el visor de mensaje único — la vista en pila solo aparece cuando hay dos o más mensajes.

Desactivable en **Configuración > Productividad > Agrupar mensajes en conversaciones**.

### Orden de conversación

De forma predeterminada, el mensaje más reciente aparece en la parte superior de la pila de tarjetas para que vea la última respuesta de inmediato — igual que los mensajes nuevos aparecen en su bandeja de entrada. Puede cambiar el orden en **Configuración > Productividad > Orden de conversación**:

- **Más reciente primero** (predeterminado) — el mensaje más reciente está arriba; los más antiguos están debajo.
- **Más antiguo primero** — los mensajes están ordenados cronológicamente de arriba a abajo, con el mensaje más reciente en la parte inferior de la pila.

La configuración se aplica a todos los hilos del panel de lectura y surte efecto de inmediato al cambiarla.

### Acciones del hilo

Al ver un hilo con dos o más mensajes, la barra de herramientas única en la parte superior del visor de mensajes pasa al modo de hilo. Es la misma barra de herramientas que se usa para los mensajes individuales — sus botones se adaptan a la semántica del hilo:

- **Responder** -- redactar una respuesta al remitente del mensaje más reciente del hilo.
- **Responder a todos** -- responder a todos los participantes del mensaje más reciente, excluyendo la dirección principal de su cuenta.
- **Reenviar** -- reenviar el mensaje más reciente del hilo a otra persona.
- **Archivar hilo** -- mueve todo el hilo a la carpeta Archivo. Desactivado si no hay ninguna carpeta de Archivo configurada.
- **Eliminar hilo** -- mueve todo el hilo a la Papelera si la cuenta dispone de una carpeta de Papelera. Si el hilo ya está en la Papelera, o la cuenta no tiene carpeta de Papelera, MailCopilot solicita confirmación antes de la eliminación permanente.
- **Marcar hilo como leído** -- marca todos los mensajes del hilo como leídos. Este botón solo aparece cuando al menos un mensaje del hilo no está leído; se oculta cuando todos los mensajes ya están leídos.
- **Posponer** -- oculta temporalmente **todo el hilo** y vuelve a mostrar todos sus mensajes en el momento elegido. El diálogo de posponer se ancla en el mensaje más reciente, pero todos los mensajes del hilo se posponen juntos. Mismas opciones que al posponer mensajes individuales. Oculto en la carpeta Borradores.
- **Spam** -- en modo de hilo, abre un cuadro de diálogo de confirmación que pregunta si se debe marcar todo el hilo como spam. Deshacer una marca de spam es más difícil que deshacer un archivado; la confirmación adicional es intencional.
- **Destacar, Fijar, Imprimir, Abrir en ventana, Abrir en cuenta** -- estos botones actúan sobre el mensaje activo (expandido) en el hilo, no sobre el hilo completo.

Responder, Responder a todos y Reenviar se dirigen al mensaje más reciente del hilo. Archivar hilo, Eliminar hilo, Marcar hilo como leído y Posponer se aplican a todos los mensajes del hilo a la vez.

### Resumen IA del hilo

Cuando abre un hilo con **tres o mas mensajes**, y el Resumen IA del hilo esta habilitado para la cuenta, aparece un resumen de una linea generado por IA encima de la pila de tarjetas. Haga clic en el para desplegar cinco puntos con los aspectos clave de la conversacion. Haga clic de nuevo en la linea del resumen para contraer los puntos.

El Resumen IA del hilo esta **deshabilitado de forma predeterminada** y debe activarse **por cuenta** en **Configuracion > IA > Resumen IA del hilo**. Consulte [Asistente IA](../ai-assistant#resumen-ia-del-hilo) para saber como habilitarlo y que se envia a su proveedor de IA.

Los hilos mas cortos (menos de tres mensajes) nunca muestran la franja de resumen -- la pila es lo bastante pequena como para leerla directamente. Solo se resume el hilo que ha abierto activamente; MailCopilot nunca resume hilos en segundo plano ni en todo su buzon.

Una vez que un hilo ha sido resumido, volver a abrirlo muestra el resumen en cache al instante -- MailCopilot no lo regenera a menos que cambien los mensajes del hilo.

Si se ha alcanzado el presupuesto diario de IA, no hay ningun proveedor de IA configurado (esto incluye una **suscripcion de Claude** configurada, que no es compatible con el Resumen IA del hilo), o el proveedor devuelve un error transitorio, la franja muestra un mensaje explicativo en lugar de un resumen. Aparece un boton **Reintentar** cuando el fallo fue un error transitorio del proveedor.

### Respuesta instantanea

Cuando la Respuesta instantanea esta habilitada para la cuenta, aparece un boton **Respuesta instantanea** en la tarjeta del mensaje abierto activamente. Haga clic en el para que la IA redacte dos o tres opciones de respuesta breves basadas en el contenido del mensaje.

Haga clic en una opcion para abrirla en una **nueva ventana de redaccion**, prellenada con ese texto -- no se envia nada automaticamente, usted sigue revisando y enviando el mensaje por su cuenta.

La Respuesta instantanea esta **deshabilitada de forma predeterminada** y debe activarse **por cuenta** en **Configuracion > IA > Respuesta instantanea**. Consulte [Asistente IA](../ai-assistant#respuesta-instantanea) para saber como habilitarla y que se envia a su proveedor de IA.

## Adjuntos

Cuando el mensaje activo tiene adjuntos, estos aparecen encima del cuerpo del mensaje. Para cada adjunto se muestra:

- Un **icono de tipo de archivo** elegido a partir del tipo MIME, con respaldo en la extension del nombre de archivo cuando el tipo MIME falta, es generico (`application/octet-stream`) o no se reconoce: PDF, imagen, archivo comprimido, documento, hoja de calculo, presentacion, texto plano, mensaje `.eml` incrustado, o un icono generico cuando no aplica nada mas especifico.
- El **nombre del archivo**.
- El **tamano del archivo**.

Las imagenes de maquetacion que el cuerpo del mensaje ya muestra en linea -- por ejemplo un logotipo en una firma HTML -- nunca se eliminan de la lista. MailCopilot no puede determinar con fiabilidad, desde fuera del navegador, si una parte concreta llego a ser visible en pantalla -- eso lo deciden la maquetacion, el CSS y la seleccion dentro de una imagen adaptable --, asi que en vez de adivinar mantiene todas las partes accesibles: los adjuntos reales (los archivos que el remitente adjunto de verdad) se listan primero, y las imagenes en linea que el cuerpo renderizo se relegan al final de la lista, detras del mismo interruptor de expansion descrito mas abajo.

Aparece un interruptor de expansion siempre que haya mas que mostrar de lo que cabe contraido -- mas de cuatro adjuntos reales, o cualquier imagen en linea relegada, incluso si hay cuatro adjuntos reales o menos. Haz clic en **Mostrar mas (N)**, donde N cuenta solo los elementos que no estan visibles ahora mismo, para revelarlo todo, y en **Mostrar menos** para volver a contraer la lista.

Haz clic en el boton de descarga de la fila del adjunto para guardar el archivo en tu equipo. El boton de descarga tiene una etiqueta accesible explicita, de modo que los lectores de pantalla anuncian la accion junto con el nombre del archivo.

## Enlaces

MailCopilot verifica los enlaces: enlaces no coincidentes, HTTP y dominios IDN.

### Clic derecho en un enlace

Haz clic derecho en un enlace dentro del cuerpo de un mensaje para abrir un pequeno menu contextual con:

- **Abrir enlace en el navegador** -- abre el enlace de la misma forma que un clic, incluidas las comprobaciones de seguridad anteriores (avisos de dominio no coincidente y de HTTP, deteccion de dominios IDN/punycode). Esta opcion solo aparece en la ventana principal y en la ventana de mensaje independiente (ver [Abrir en ventana](#abrir-en-ventana)) -- no se ofrece en las ventanas de Configuracion, Redactar o Cuenta, ya que ninguna de ellas muestra enlaces de correo.
- **Copiar dirección del enlace** -- copia el destino real del enlace al portapapeles, no su texto visible, y nunca la forma interna de enrutamiento que MailCopilot usa para representar el enlace. Para una direccion web (`http:`/`https:`) con un nombre de dominio internacionalizado, la direccion se copia en su forma punycode (ASCII) -- la forma que su navegador usara realmente -- en lugar de la forma Unicode, de modo que una direccion copiada no pueda ocultar un dominio similar detras de caracteres legibles. Para una direccion `mailto:`, un dominio internacionalizado se codifica en porcentaje en su lugar, ya que los clientes de correo no lo resuelven como un host punycode. Las credenciales incrustadas en un enlace (`https://user:pass@host/…`) se copian tal cual, sin eliminarse -- si pega ese enlace en otro lugar, las credenciales lo acompanan.

Ninguna de las dos opciones aparece para enlaces que no comiencen con `http:`, `https:` o `mailto:` (por ejemplo, un enlace `javascript:` o `data:` incrustado en un mensaje), ni para una direccion de enlace de mas de 8192 caracteres.

## Acciones

Responder (**r**), Responder a todos (**a**), Reenviar (**f**), Destacar (**s**), Eliminar (**#**), Archivar (**e**), Spam (**!**), Leido/No leido (**Shift+I**/**Shift+U**), Mover (**v**), Posponer.
- **Fijar / Desfijar** -- fijar un mensaje en la parte superior de la lista. Los mensajes fijados siempre aparecen primero, independientemente del orden (atajo: **p**).
- **Abrir en ventana** -- abrir el mensaje en una ventana independiente para leerlo junto a otro contenido.
- **Imprimir** -- imprimir el correo actual (atajo: **Ctrl+P**).

## Abrir en ventana

La acción **Abrir en ventana** abre el mensaje actual en una ventana independiente dedicada. Esto es útil cuando desea leer un mensaje o actuar sobre él mientras mantiene la ventana principal libre para navegar por otras carpetas.

La ventana independiente es un espacio de trabajo completamente funcional. Incluye una barra de acciones completa en la parte superior con todos los botones necesarios:

- **Responder** -- redactar una respuesta al remitente.
- **Responder a todos** -- responder a todos los destinatarios.
- **Reenviar** -- reenviar el mensaje a otro destinatario.
- **Archivar** -- mover el mensaje a la carpeta de Archivo. El botón está desactivado si no hay ninguna carpeta de Archivo configurada para la cuenta.
- **Eliminar** -- mover el mensaje a la Papelera cuando la cuenta dispone de una carpeta de Papelera. Si la cuenta no tiene carpeta de Papelera, o el mensaje ya se encuentra en la Papelera, MailCopilot solicita confirmación antes de eliminarlo permanentemente.
- **Destacar / Quitar destacado** -- activar o desactivar el estado destacado del mensaje.
- **Marcar como leído / no leído** -- cambiar el estado de lectura.
- **Imprimir** -- imprimir el cuerpo del mensaje.

Al hacer clic en **Archivar**, o en **Eliminar** para un mensaje que puede moverse a la Papelera, la ventana independiente muestra un banner de deshacer integrado durante 3 segundos antes de que MailCopilot realice el movimiento y cierre la ventana. Haga clic en **Deshacer** para cancelar la operación — el mensaje permanece en su lugar y la ventana sigue abierta. Mientras el banner de deshacer sea visible, los botones **Archivar** y **Eliminar** están desactivados; **Responder**, **Responder a todos**, **Reenviar**, **Destacar / Quitar destacado**, **Marcar como leído / no leído** e **Imprimir** siguen disponibles.

Si la cuenta no tiene carpeta de Papelera, o el mensaje ya se encuentra en la Papelera, **Eliminar** solicita confirmación antes de eliminarlo permanentemente — no aparece ningún banner de deshacer y la acción es irreversible.

La ventana independiente utiliza las mismas protecciones básicas que el panel de lectura principal: HTML saneado en un iframe aislado sin scripts, imágenes remotas bloqueadas y avisos de phishing para los enlaces.

## Posponer mensajes

Posponer te permite ocultar un mensaje temporalmente para que reaparezca en el momento que elijas.

### Como posponer

Haz clic derecho en un mensaje de la lista y selecciona **Posponer** en el menu contextual.

### Opciones de aplazamiento

Elige un momento predefinido o configura una fecha y hora personalizada:

- **Mas tarde hoy** -- la siguiente marca de media hora.
- **Manana por la manana (09:00)**.
- **La proxima semana (lunes 09:00)**.
- **Personalizado** -- elige cualquier fecha y hora futura.

### Carpeta de pospuestos

Los mensajes pospuestos aparecen en la carpeta **Pospuestos** en la barra lateral. Cuando llega la hora programada, el mensaje vuelve a ser visible en su carpeta original y recibes una notificacion.

Haz clic en cualquier mensaje pospuesto para abrirlo y leerlo sin cancelar el aplazamiento. Para cancelar el aplazamiento antes de tiempo, haz clic en el botón **Cancelar** junto al mensaje.

## Leer más tarde

La función «Leer más tarde» le permite guardar correos para leerlos después — ideal para newsletters largos, material de referencia o cualquier cosa a la que quiera volver más tarde.

### Cómo añadir a «Leer más tarde»

- Haga clic derecho en un mensaje y elija **Leer más tarde** en el menú contextual.
- O pida al asistente de IA que marque un correo para leer más tarde.

### La carpeta «Leer más tarde»

Los mensajes marcados aparecen en la carpeta **Leer más tarde** en la barra lateral (icono de libro). A diferencia de los correos pospuestos, los correos de «Leer más tarde» permanecen visibles en su carpeta original — la carpeta es una vista adicional, no un filtro.

Haga clic en cualquier mensaje de la carpeta «Leer mas tarde» para abrirlo y leerlo. Para eliminar un mensaje de la lista, haga clic en el boton **Quitar de la lista** junto al mensaje.

Puede abrir la carpeta «Leer mas tarde» desde la barra lateral.

## Cuando un mensaje no puede cargarse

Si MailCopilot no puede recuperar el cuerpo del mensaje -- por ejemplo porque la conexion al servidor IMAP expiro (despues de 10 segundos) -- muestra un marcador de posicion en lugar de una pantalla en blanco:

> «El cuerpo del mensaje no esta disponible sin conexion. Solo se almacenan en cache las cabeceras.»

Aparece un boton **Reintentar** debajo del mensaje. Haga clic para intentar recuperar el cuerpo de nuevo. Si la conexion se ha restablecido, el mensaje se cargara con normalidad.

## Invitaciones a reuniones

Cuando un mensaje contiene una invitación de calendario (un adjunto `.ics` que usa el protocolo iTIP), MailCopilot muestra una tarjeta **Invitación a reunión** integrada encima del cuerpo del mensaje. No se necesita ninguna aplicación de calendario externa ni servicio en la nube.

La tarjeta muestra:

- **Título del evento** — el resumen de la reunión.
- **Cuándo** — la fecha y hora de inicio.
- **Organizador** — el organizador indicado en la invitación de calendario (puede diferir del remitente del correo si la invitación se envió en nombre de otra persona).
- **Lugar** — la sala de reuniones o el enlace de conferencia, si se ha proporcionado.

Debajo de los detalles del evento hay tres botones de respuesta disponibles: **Aceptar**, **Tal vez** y **Rechazar**. Al hacer clic en cualquiera de ellos, MailCopilot envía un correo de respuesta iTIP estándar al organizador por SMTP usando las credenciales de su cuenta. La tarjeta se actualiza para confirmar su elección (por ejemplo, «Ha aceptado esta invitación»). Si no se puede enviar la respuesta, se muestra un mensaje de error en su lugar.

Los botones Aceptar / Tal vez / Rechazar solo aparecen para invitaciones de reunión activas (`METHOD:REQUEST`) donde el organizador no es usted. Cancelaciones, publicaciones de fuentes de calendario, respuestas y eventos organizados por usted no muestran botones RSVP — verá en su lugar una etiqueta «Cancelado» o un aviso «No requiere acción».

### Limitaciones en esta versión

- **Sin integración con el calendario del sistema.** MailCopilot no añade el evento a su calendario del sistema operativo (macOS Calendario, GNOME Calendar, etc.). Esta función está prevista para una versión futura.
- **Eventos recurrentes.** Las reuniones repetidas se muestran como un único evento; el patrón de recurrencia no se muestra.
- **Contrapropuestas.** No es posible proponer otro horario — solo están disponibles Aceptar, Tal vez o Rechazar.
- **Eventos cancelados.** Cuando el organizador cancela una reunión, la tarjeta muestra «Este evento ha sido cancelado» y los botones de respuesta quedan ocultos.

## Deshacer

En las vistas de carpeta de cuenta, archivar, marcar como spam o mover a la papelera muestra una barra de deshacer con cuenta regresiva. Haga clic en **Deshacer** antes de que expire el temporizador. Las eliminaciones permanentes y algunas acciones en la bandeja unificada o entre cuentas no muestran barra de deshacer.
