---
sidebar_position: 1
title: Configuracion general
---

# Configuracion general

## Tema

Elige entre **Claro** y **Oscuro**. La interfaz se actualiza de inmediato al cambiar. Cuando el modo oscuro está activo, las ventanas se abren con fondo oscuro desde el primer instante, sin destello blanco.

## Idioma

6 idiomas: English, Espanol, Francais, Deutsch, Italiano, Ruso. Cambio instantaneo.

## Retención de mensajes

Controla cuánto tiempo se conservan las copias completas de los mensajes (contenido HTML, imágenes incrustadas y archivos adjuntos) en el disco. Abra **Configuración > General** y use la lista desplegable **Conservar el cuerpo completo durante** para elegir un período. Los mensajes más antiguos permanecen buscables a través de sus encabezados y texto sin formato — solo se elimina el archivo `.eml` enriquecido al expirar.

| Opción | Duración |
|--------|----------|
| 30 días | ~1 mes |
| 90 días | ~3 meses |
| 180 días | ~6 meses |
| 1 año | 365 días (predeterminado) |
| Indefinidamente | Sin eliminación automática |

Cuando acorta el período de retención, MailCopilot muestra una vista previa de cuántos mensajes en caché se eliminarán antes de aplicar el cambio. Los mensajes en el servidor nunca se modifican -- solo la copia local se ve afectada.

## Aplicacion de correo predeterminada

El interruptor decide si MailCopilot se registra ante el sistema operativo como manejador de los enlaces `mailto:`. Cuando esta activado, hacer clic en un enlace «enviar correo» en tu navegador, terminal u otra aplicacion de escritorio abre la ventana de redaccion de MailCopilot con el destinatario y demas parametros (`to`, `cc`, `bcc`, `subject`, `body`) ya rellenados.

El registro es opt-in: MailCopilot no reclama el protocolo a menos que actives explicitamente este interruptor. En Linux el registro se hace mediante la declaracion `MimeType` del archivo desktop; en macOS mediante `open-url`; en Windows mediante la entrada de protocolo en `HKCR\mailto`. Puedes revertirlo en cualquier momento desactivando este interruptor o cambiando el manejador de correo predeterminado en los ajustes del sistema.

Cuando MailCopilot se lanza por segunda vez -- por ejemplo al pulsar un enlace `mailto:` mientras la app ya esta abierta -- la ventana existente se trae al frente en lugar de abrir un duplicado, de forma que siempre tienes una unica instancia en ejecucion.

## Corrección ortográfica

La corrección ortográfica está **desactivada de forma predeterminada**. Activarla descarga un archivo de diccionario desde un servidor externo (el de Google), y MailCopilot te pide permiso antes -- con cada idioma nuevo que añadas. Esto es deliberado: MailCopilot nunca activa un idioma que no hayas aprobado. La descarga en sí la realiza el motor de navegador integrado en la aplicación (Chromium), que se conecta al servidor de Google -- MailCopilot no puede cancelar una solicitud que ya se ha iniciado. Si una descarga llega a iniciarse para un idioma que no aprobaste, MailCopilot lo detecta y vuelve a desactivar la corrección ortográfica, en lugar de dejarla activada sin que lo notes.

Activa **«Revisar la ortografía mientras escribo»** para encender la corrección. A partir de ahí, las palabras mal escritas se subrayan en cualquier lugar donde puedas escribir texto -- al redactar, en los campos de configuración, etc.

### Elegir diccionarios

Una vez activada la corrección ortográfica, usa **«Diccionarios»** para añadir uno o varios idiomas. La lista de idiomas disponibles viene del propio motor de corrección ortográfica, no de una lista fija integrada en MailCopilot -- lo que ves depende de lo que esta compilación de la aplicación pueda ofrecer realmente. Puedes añadir varios idiomas a la vez; todos se revisan simultáneamente. Cada idioma añadido se puede quitar de nuevo con su botón **«Quitar»**. Si «Revisar la ortografía mientras escribo» está activado pero no se ha elegido ningún diccionario, la corrección permanece desactivada en la práctica -- se requiere un diccionario.

El número de diccionarios activos al mismo tiempo tiene un límite; el límite actual se muestra junto al selector.

### Permiso de descarga

La primera vez que añades un idioma que no ha sido aprobado antes, MailCopilot muestra un diálogo preguntando si se debe descargar el diccionario de ese idioma, y nombra el servidor externo del que proviene el archivo. Nada de lo que escribes se envía nunca a ningún sitio -- la revisión siempre ocurre en tu ordenador; solo se descarga el propio archivo de diccionario.

- Elegir **«Descargar»** aprueba el idioma: MailCopilot recuerda esa aprobación y deja que la descarga se realice. La aprobación queda registrada para ese idioma de forma permanente -- si el diccionario necesita descargarse de nuevo más adelante (por ejemplo, tras volver a activar un idioma que ya habías aprobado), ocurrirá sin volver a preguntarte.
- Elegir **«Cancelar»** (o cerrar el diálogo) equivale a rechazar: ese idioma **no** se activa, pero la decisión no se recuerda como un rechazo permanente -- puedes añadir el mismo idioma más tarde y simplemente se te volverá a preguntar. El resto de cambios hechos en el mismo guardado se aplican igualmente: rechazar la descarga de un diccionario nunca bloquea el resto de tus cambios.

### macOS

En macOS, la corrección ortográfica pertenece al sistema operativo, no a MailCopilot. En macOS no hay selector de diccionarios ni diálogo de permiso de descarga, porque macOS no descarga nada e ignora cualquier lista de idiomas que MailCopilot pudiera enviarle -- la configuración lo explica y solo muestra el interruptor de encendido/apagado. Para cambiar los idiomas que revisa macOS, ve a Ajustes del Sistema → Teclado → Entrada de texto.

### Corregir una palabra mal escrita

Haz clic derecho sobre una palabra subrayada como mal escrita para ver una lista corta de reemplazos sugeridos, además de un elemento **«Añadir al diccionario»**. Hacer clic en una sugerencia reemplaza la palabra; **«Añadir al diccionario»** añade la palabra a tu diccionario personal para que deje de marcarse. Por ahora no hay forma de revisar o eliminar las palabras que has añadido a tu diccionario personal desde MailCopilot.

## Icono en la bandeja del sistema y funcionamiento en segundo plano

MailCopilot puede mostrar un icono en la bandeja del sistema. **«Mostrar icono en la bandeja del sistema»** está activado de forma predeterminada; su menú ofrece **«Abrir MailCopilot»**, **«Nuevo mensaje»**, **«Comprobar correo»** y **«Salir»**, y mientras el icono existe, pasar el cursor sobre él muestra el número de mensajes no leídos en su información sobre herramientas -- hasta 999, y después **«999+»**.

### Cerrar la ventana a la bandeja

Activa **«Cerrar la ventana a la bandeja»** (desactivado de forma predeterminada) para que MailCopilot siga funcionando cuando cierres la ventana principal en lugar de salir de la aplicación -- el correo sigue sincronizándose en segundo plano y las notificaciones de correo nuevo siguen llegando. Para recuperar la ventana, haz clic en el icono de la bandeja (o en su elemento de menú **«Abrir MailCopilot»**); usa **«Salir»** en el menú de la bandeja para salir realmente de la aplicación.

Elegir **«Salir»** no retira el icono de la bandeja de inmediato. Antes de salir realmente, MailCopilot realiza un punto de control de su base de datos local -- de ahí la breve demora, normalmente bastante menos de un segundo. Mientras esto ocurre, la información sobre herramientas del icono muestra **«Cerrando…»**, y su menú muestra una única línea inactiva **«Cerrando…»** en lugar de las opciones habituales, para que puedas notar que la aplicación todavía está cerrándose y no pensar que Salir solo retiró el icono. Si en el momento de salir un mensaje aún se estaba enviando, no se pierde: MailCopilot envía a través de una cola local, así que un envío inconcluso simplemente permanece en la cola y sale la próxima vez que ejecutes MailCopilot.

Este ajuste depende de si el icono se creó correctamente, no de si algo lo muestra: en Linux, MailCopilot crea el icono incluso cuando ningún host de bandeja lo acepta, por lo que **«Cerrar la ventana a la bandeja»** funciona siempre que exista el objeto del icono -- lo muestre o no realmente tu escritorio. El ajuste solo carece de efecto si MailCopilot no pudo crear el icono en absoluto (una imagen de icono vacía o ilegible, o una plataforma que se niega a construirlo).

MailCopilot no comprueba antes de ocultar la ventana si tu escritorio dibuja realmente el icono -- esa es una decisión del escritorio, no de MailCopilot; una nota bajo el ajuste lo señala para Linux. Si el icono nunca llega a dibujarse, no hay nada en lo que hacer clic, pero ocultar la ventana sigue siendo reversible en cualquier caso: volver a iniciar MailCopilot trae la ventana oculta de vuelta al primer plano, tanto si el icono funciona, como si se dibuja mal o nunca apareció.

Si las notificaciones están activadas, la primera vez que un cierre oculta la ventana a la bandeja en una sesión, MailCopilot muestra un breve aviso único confirmando que sigue funcionando en segundo plano y que hacer clic en el icono trae de vuelta la ventana.

Si alguna vez cierras MailCopilot esperando que se quede en la bandeja y luego no lo encuentras, consulta [Cerré la ventana y ahora no encuentro MailCopilot](../faq#cerré-la-ventana-y-ahora-no-encuentro-mailcopilot) en las preguntas frecuentes.

### Insignia de no leídos

Mientras tengas mensajes no leídos, MailCopilot muestra una insignia sobre el icono de la aplicación -- una insignia numérica en el dock (macOS) o el lanzador de Unity (Linux), y un punto en el botón de la barra de tareas (Windows); el número en sí (hasta 999, y después **«999+»**) está disponible en la información sobre herramientas del icono de la bandeja mientras ese icono exista. La insignia respeta las mismas carpetas que excluiste del recuento de no leídos en la [configuración de carpetas](folders-settings#insignias-de-no-leídos).

### Iniciar al iniciar sesión

Activa **«Iniciar al iniciar sesión»** (desactivado de forma predeterminada) para que MailCopilot se inicie automáticamente cuando inicies sesión en tu ordenador. En Windows y macOS, esto registra MailCopilot como elemento de inicio de sesión ante el sistema operativo; en Linux, crea una entrada de inicio automático (un archivo `.desktop`) para que tu entorno de escritorio inicie MailCopilot al iniciar sesión.

El interruptor registra lo que has pedido; debajo aparece una nota siempre que el resultado real no coincida con eso. Si esta plataforma o compilación no puede registrar el inicio automático en absoluto, MailCopilot indica que el ajuste no surte efecto aquí. Si la activación falló, una nota explica que no se pudo registrar el inicio automático y que se reintentará la próxima vez que guardes. Si la desactivación falló, MailCopilot indica que la aplicación seguirá iniciándose al iniciar sesión y que la eliminación se reintentará automáticamente la próxima vez que guardes -- para que nunca pienses que el inicio automático está desactivado cuando en realidad no lo está.

## Confianza de certificados TLS

MailCopilot verifica cada certificado TLS que presentan tus servidores de correo tanto frente al conjunto de certificados de Mozilla integrado como frente al almacén de certificados de tu sistema operativo. Confiar también en el almacén del sistema significa que el software de seguridad que inspecciona el tráfico TLS (por ejemplo, Kaspersky y antivirus similares) y los proxies corporativos ya no interrumpen la sincronización del correo en Windows, macOS o Linux -- MailCopilot reconoce los certificados que presentan estas herramientas como válidos en lugar de rechazar la conexión. La verificación de certificados nunca se debilita por esto: un certificado sigue necesitando ser de confianza según una de estas dos fuentes, o estar fijado explícitamente, para ser aceptado. Si el almacén de certificados de tu sistema operativo no se puede leer, MailCopilot recurre solo al conjunto Mozilla integrado en lugar de omitir la verificación.

### Recuperación tras un cambio de certificado

Si un servidor presenta alguna vez un certificado en el que no se puede confiar -- por ejemplo, ya no coincide con un certificado aceptado anteriormente, o un certificado autofirmado cambió tras una rotación -- MailCopilot muestra el diálogo **«El servidor presentó un certificado diferente»** directamente en la ventana principal, no solo durante la configuración de la cuenta. El diálogo indica el servidor, el emisor y la huella digital SHA-256 del nuevo certificado.

La confirmación se hace en hasta dos pasos, para que lo que apruebas siempre coincida con lo que realmente se muestra en pantalla:

- Si la huella digital aún no se ha leído, el botón principal muestra **«Leer el certificado»**. Haz clic para obtener el certificado del servidor; sus detalles reemplazan entonces el marcador de posición en el diálogo.
- Una vez que se muestra una huella digital, el botón dice **«Confiar y continuar»**. Haz clic para aceptar exactamente el certificado mostrado.
- Si el certificado del servidor cambia de nuevo entre la apertura del diálogo y la confirmación, MailCopilot rechaza la confirmación obsoleta y vuelve a leer el certificado para mostrarte los nuevos detalles -- pero la oferta de confianza de ese diálogo estaba vinculada al certificado mostrado inicialmente, y volver a leerlo no la renueva, así que confirmar de nuevo seguirá fallando de la misma forma. Haz clic en **«Cancelar»** para cerrar este diálogo y deja que MailCopilot intente conectarse de nuevo; aparecerá un diálogo nuevo con el certificado actual, que sí puedes confirmar. Mientras tanto no se confía en nada.

Elige **«Cancelar»** en cualquier momento para mantener el estado anterior. El mismo servidor no volverá a mostrar este diálogo más de una vez por minuto. La oferta de confianza del diálogo tampoco permanece abierta indefinidamente -- si ha estado sin responder durante mucho tiempo, confirmarla puede ser rechazado; en ese caso, cancela y espera a que aparezca un diálogo nuevo.

### Reconfirmar un servidor autofirmado fijado tras actualizar

La fijación de certificados ahora se aplica de forma estricta para certificados que no superan la verificación normal de la cadena: antes, la fijación solo comparaba huellas digitales para certificados cuya cadena ya se verificaba con normalidad, mientras que los certificados autofirmados y con autoridad de certificación privada -- el caso exacto para el que existe la fijación -- se saltaban por completo la comprobación de la huella digital. Ese vacío ya está cerrado. Si fijaste un servidor de correo autofirmado o con una autoridad de certificación privada antes de este cambio, la fijación guardada puede contener solo una huella digital, sin el certificado necesario para verificarlo realmente -- ese servidor dejará de conectarse tras la actualización, y MailCopilot mostrará el diálogo de recuperación de certificado descrito arriba.

Para solucionarlo, reconfirma el certificado a través de ese diálogo: si el botón muestra **«Leer el certificado»**, haz clic primero en él para obtener el certificado, y luego en **«Confiar y continuar»**; si ya se muestra **«Confiar y continuar»**, haz clic solo en ese. Esto guarda la fijación junto con el propio certificado, y la sincronización se reanuda automáticamente. Solo necesitas hacer esto una vez por cada servidor afectado. Agregar o editar una fijación manualmente en **Configuración** no soluciona esto por sí solo -- para un certificado que de otro modo no es de confianza (autofirmado, o emitido por una autoridad de certificación privada que aún no está en el almacén de tu sistema operativo), solo el diálogo de recuperación puede concederle confianza; consulta [Cuándo usar la fijación de certificados](#cuándo-usar-la-fijación-de-certificados) más abajo para saber por qué.

### Aviso de inspección

Tras la primera sincronización exitosa de una cuenta en una sesión, MailCopilot comprueba una vez si su conexión con el servidor de correo está siendo inspeccionada por un antivirus o proxy (el certificado solo es de confianza a través del almacén del sistema) y, si es así, muestra un aviso como «La conexión con `{{host}}` está siendo inspeccionada.», nombrando al emisor cuando se conoce. Esta comprobación se ejecuta como máximo una vez por servidor durante toda la vida de tu perfil, se haya encontrado inspección o no -- así que si la inspección se activa en un servidor *después* de que esta comprobación única ya se ejecutó sin encontrar nada, MailCopilot no lo detectará. El aviso se puede descartar.

Los errores de certificado se reintentan con un intervalo largo (6 horas) en lugar del intervalo corto usado para fallos de red comunes, ya que requieren tu decisión y no se resolverán por sí solos.

## Fijación de certificados TLS

La fijación de certificados TLS agrega una capa adicional de seguridad para tus conexiones de correo. Garantiza que tu cliente solo se conecte a servidores que presenten un certificado específico, protegiéndote contra ataques de intermediario (man-in-the-middle).

### Gestión de certificados fijados

1. Abre **Configuración** y ve a la sección **Cuentas**.
2. Haz clic en **Editar** en una cuenta para abrir su configuración.
3. Desplázate hasta la sección **Fijación de certificados TLS**.

La sección muestra una tabla de certificados fijados con su host, puerto, huella digital y la fecha en que fueron agregados.

### Agregar una fijación

1. Haz clic en **Añadir pin**.
2. Introduce el **host** (por ejemplo, `imap.gmail.com`) y el **puerto** (por ejemplo, `993`).
3. Haz clic en **Obtener y fijar**. MailCopilot se conecta al servidor, obtiene su certificado y te muestra la huella digital.
4. Confirma para guardar la fijación.

Una fijación agregada de esta forma solo *restringe* qué certificado se acepta para un servidor que ya es de confianza a través del conjunto Mozilla habitual o el almacén de certificados de tu sistema operativo -- no hace por sí sola que un certificado autofirmado o con autoridad de certificación privada, que de otro modo no sería de confianza, pase a serlo. Para un servidor de correo autofirmado (o con una autoridad de certificación privada que aún no está en el almacén de tu sistema operativo), agregar una fijación aquí no basta para conectarse; necesitas confirmarlo a través del diálogo de recuperación de certificado descrito en [Confianza de certificados TLS](#confianza-de-certificados-tls), el único lugar donde MailCopilot concede confianza a ese tipo de certificado.

### Eliminar una fijación

Haz clic en el botón de eliminar junto a cualquier fijación en la tabla para eliminarla. Esto solo elimina la fijación guardada -- después, MailCopilot aceptará cualquier certificado válido de ese servidor.

Agregar una fijación reconecta automáticamente MailCopilot al servidor de correo para que el cambio surta efecto inmediatamente. Eliminar una fijación no provoca una reconexión automática -- el cambio surte efecto la próxima vez que MailCopilot se conecte a ese servidor.

### Servidores STARTTLS (puertos 143 y 587)

Los servidores a los que se accede mediante STARTTLS (normalmente el puerto IMAP 143 o el puerto SMTP 587, donde la conexión empieza en texto plano y luego pasa a TLS) no entregan su certificado en el momento en que MailCopilot lo captura para la fijación. Para estos servidores solo se guarda la huella digital, no el certificado en sí -- así que un servidor STARTTLS autofirmado o con autoridad de certificación privada no puede hacerse utilizable de esta forma; usa TLS implícito (normalmente el puerto 993 para IMAP, 465 para SMTP) si tu servidor lo admite.

### Cuándo usar la fijación de certificados

La fijación de certificados es especialmente útil en entornos corporativos o situaciones en las que necesitas verificar que tus conexiones de correo van a los servidores esperados. Para la mayoría de los usuarios personales, la verificación TLS predeterminada es suficiente.
