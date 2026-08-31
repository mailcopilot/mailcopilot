---
sidebar_position: 5
title: Reglas de correo
---

# Reglas de correo

Las reglas de correo te permiten ordenar y organizar automáticamente los correos entrantes según condiciones que tú defines. Las reglas se ejecutan cada vez que MailCopilot descarga correo del servidor, no necesariamente en el instante en que un mensaje llega allí.

## Crear una regla

1. Abre **Configuración > Reglas**.
2. Haz clic en **Añadir regla**.
3. Dale un nombre a tu regla.
4. Elige a qué cuenta se aplica la regla (o selecciona «Todas las cuentas»).

### Condiciones

Cada regla tiene una o más condiciones. Todas las condiciones deben coincidir para que la regla se active (lógica Y). Si necesitas lógica O, crea reglas separadas.

Campos de condición disponibles:
- **Remitente — dirección** — se compara únicamente con la dirección de correo del remitente. Si una regla que mueve, archiva, elimina correo o lo marca como spam filtra por el remitente, este es el único campo de remitente que MailCopilot le permite usar -- consulta más abajo.
- **Remitente — nombre visible** — se compara únicamente con el nombre visible del remitente, el texto libre que aparece junto a la dirección (por ejemplo, «Juan Pérez» en `Juan Pérez <juan@example.com>`). Limitación conocida: si el nombre visible guardado de un remitente es textualmente idéntico a su propia dirección, MailCopilot trata a ese remitente como si no tuviera nombre visible alguno, así que esta condición no coincidirá con él -- compara con **Remitente — dirección** para ese remitente. MailCopilot no permite que este campo condicione una regla que mueva, archive, elimine correo o lo marque como spam -- consulta más abajo.
- **Remitente — nombre o dirección (obsoleto)** — el campo combinado original: coincide si el nombre visible *o* la dirección coincide (**no contiene** es la excepción -- ver más abajo). Su comportamiento de coincidencia cambió cuando el campo anterior se dividió en **Remitente — dirección** y **Remitente — nombre visible**: antes comparaba un único valor -- el nombre visible, recurriendo a la dirección solo cuando el remitente no tenía nombre visible configurado --, así que una regla en este campo nunca coincidía por dirección con un remitente que tuviera firma. Ahora siempre compara ambos valores juntos, así que una regla ya configurada en este campo puede empezar a coincidir con mensajes con los que antes no coincidía (y, en el caso de **no contiene**, puede dejar de excluir mensajes que antes excluía). Si tienes reglas existentes en este campo, revisa con qué coinciden ahora, especialmente las que mueven, eliminan o marcan correo como spam. Ya no se ofrece para condiciones nuevas -- consulta «Campo obsoleto» más abajo. **No contiene** en este campo es la excepción: como significa «no debe coincidir con ninguno de los dos», exige que el texto esté ausente tanto del nombre visible como de la dirección. Por ejemplo, una regla «no contiene example.com» no coincidirá con un mensaje cuyo nombre visible incluya ese texto, aunque la dirección no lo incluya.
- **Destinatario** — dirección del destinatario.
- **Cc** — ya no se ofrece al añadir una condición nueva. MailCopilot no guarda el campo Cc de los correos en caché, así que una condición sobre él nunca podía comprobarse de verdad, y según el operador se comportaba de forma imprevisible en lugar de simplemente «no funcionar»: coincidir con una dirección concreta en Cc nunca funcionaba, pero un operador de exclusión como **no contiene**, o una expresión regular que coincide con una cadena vacía, coincidía en cambio con **todos** los correos -- una regla pensada para atrapar unos pocos mensajes podía vaciar toda una bandeja de entrada. Si una regla que configuraste antes de este cambio todavía tiene una condición de Cc, sigue apareciendo en el editor de reglas con una advertencia de que la condición nunca puede cumplirse, así que la regla ya no coincide con nada y ya no se ejecuta -- pero la regla en sí permanece en tu lista, sin cambios, hasta que la abras para editarla, y la propia lista de reglas la marca con la etiqueta **«No se aplica»**, así que no hace falta abrirla para darse cuenta (consulta «Reglas marcadas como no aplicadas» más abajo). Abrirla en el editor y guardarla se rechaza, igual que activar **«Aplicar a correos existentes en la bandeja de entrada»** para ella, hasta que elimines la condición de Cc o la sustituyas por un campo compatible. Aun así no te quedas sin salida: la casilla junto a la regla en la lista sigue activándola o desactivándola, y eliminarla desde la lista también funciona siempre.
- **Asunto** — la línea de asunto del correo.
- **Tiene adjunto** — si el correo tiene archivos adjuntos.

Operadores disponibles:
- **contiene** / **no contiene** — coincidencia parcial.
- **es igual a** — coincidencia exacta.
- **comienza con** / **termina en** — coincidencia por prefijo o sufijo.
- **coincide con regex** — búsqueda avanzada de patrones mediante expresiones regulares.

### El nombre visible se puede falsificar

Un remitente controla por completo su propio nombre visible -- es texto libre que él mismo define, no algo que el servidor de correo verifique. Eso significa que un remitente puede poner como nombre visible una cadena que se lea exactamente como una dirección, por ejemplo `user@example.com`, sea cual sea la dirección que realmente indique la cabecera `From:` del mensaje. Una regla como «Remitente — nombre visible es igual a user@example.com» coincide con ese nombre visible por sí solo, con independencia de la dirección -- y lo mismo ocurre con esa condición en **Remitente — nombre o dirección (obsoleto)**, porque ese campo también comprueba el nombre visible.

La dirección y el nombre visible se guardan y se comparan por separado, así que el texto que un remitente escribe en el nombre visible nunca se lee como una dirección -- pero eso no hace que la dirección en sí sea de fiar: el remitente redacta toda la cabecera `From:`, dirección incluida, así que es igual de falsificable (ver más abajo). Lo que aporta esa separación es más limitado: si una regla que mueve, archiva, elimina correo o lo marca como spam filtra por el remitente, y ese filtro está en **Remitente — nombre visible** o en el campo obsoleto, MailCopilot la rechaza -- una regla que combine uno de esos campos con **Mover a papelera**, **Marcar como spam**, **Archivar** o **Mover a carpeta** no se puede guardar. Esto solo afecta a qué campo usa una condición sobre el *remitente*; una regla que realiza una de estas acciones sin filtrar en absoluto por el remitente -- por asunto, destinatario o si tiene adjunto, por ejemplo -- no se ve afectada. Si una regla ya existente tiene esa combinación -- de antes de que existiera esta restricción --, abrirla en el editor y guardarla se rechaza, igual que ejecutar **«Aplicar a correos existentes en la bandeja de entrada»** sobre ella; el mensaje indica el campo y la acción que causaron el rechazo, y te remite en su lugar a **Remitente — dirección**. Hasta que lo corrijas, esa regla también deja de coincidir con el correo nuevo -- pero no en silencio: la lista de reglas la marca con la etiqueta **«No se aplica»**, así que no hace falta abrirla para darse cuenta (consulta «Reglas marcadas como no aplicadas» más abajo). **Aun así, no te quedas sin salida: la casilla junto a la regla en la lista sigue activándola o desactivándola, sin que el rechazo lo impida -- es la forma más rápida de detener una regla que no puedes guardar de otro modo.** Eliminar la regla desde la lista también funciona siempre. La restricción en sí no afecta a **Marcar como leído** ni a **Destacar**: ninguna de las dos puede destruir ni ocultar correo, así que un remitente falsificado que dispare una de ellas no te cuesta nada irreversible, y ambos campos todavía pueden condicionarlas.

Conviene ser precisos sobre qué demuestra y qué no demuestra **Remitente — dirección**, ya que es el campo al que apunta esta restricción: no es una garantía de que el mensaje venga realmente de esa dirección. Se lee directamente de la cabecera `From:` del mensaje, y MailCopilot no verifica esa cabecera de forma criptográfica -- comprobarla contra firmas DKIM o DMARC es un trabajo aparte, todavía no implementado --, así que un mensaje puede seguir declarando cualquier dirección ahí, con la misma libertad que cualquier nombre visible. Lo que sí aporta coincidir en este campo es algo más limitado pero real: como la dirección y el nombre visible son campos distintos, un nombre visible que un remitente escribió para parecer una dirección nunca se compara como tal, así que un nombre visible falsificado puede satisfacer una condición sobre **Remitente — nombre visible**, pero no puede, por sí solo, satisfacer una condición sobre **Remitente — dirección**. Trata una coincidencia en **Remitente — dirección** como «esa dirección se declaró en el mensaje», no como una identidad verificada.

### Campo obsoleto

**Remitente — nombre o dirección (obsoleto)** es el campo «Remitente» original, sin dividir, conservado para las reglas que ya estaban configuradas con él antes de la división descrita arriba. Todavía puedes abrir y editar una regla que lo use, pero su comportamiento de coincidencia ha cambiado desde entonces -- consulta la nota en «Condiciones» más arriba --, así que conviene revisar con qué coincide ahora una regla existente en este campo, especialmente las que mueven, eliminan, archivan correo o lo marcan como spam (por qué se rechaza esa combinación -- consulta «El nombre visible se puede falsificar» más arriba).

Lo importante es que la interfaz tiene una puerta de un solo sentido: el campo obsoleto solo aparece en el menú desplegable de campos de condición mientras una condición siga configurada con él. En cuanto cambies esa condición a cualquier otro campo (incluso si cambias y vuelves atrás), la opción obsoleta desaparece del menú y ya no hay forma de volver a seleccionarla desde la interfaz -- tendrías que recrear la condición con **Remitente — dirección** o **Remitente — nombre visible**. Decide antes de cambiar, no después.

### Acciones

Cuando una regla coincide, se realizan una o más acciones:

- **Archivar** — mover a la carpeta Archivo.
- **Mover a papelera** — mover a la carpeta Papelera.
- **Mover a carpeta** — mover a una carpeta específica de tu elección.
- **Marcar como leído** — marcar automáticamente el correo como leído.
- **Destacar** — marcar el correo con una estrella.
- **Marcar como spam** — mover a la carpeta Spam.

### Dejar de procesar las reglas

Si activas **«Dejar de procesar las reglas siguientes»**, no se evaluarán más reglas después de que esta se active. Esto es útil cuando tienes una regla general y quieres evitar que anule reglas más específicas.

## Reglas marcadas como no aplicadas

Si las condiciones o acciones de una regla no pueden justificar de forma fiable lo que hace, MailCopilot se niega a ejecutarla -- y lo marca en la lista de reglas en lugar de dejarla inactiva en silencio. La etiqueta aparece en lugar del resumen habitual «N condiciones, M acciones» para esa regla, esté activada o desactivada, así que no hace falta abrir una regla para descubrir que en realidad no se está ejecutando.

- **«No se puede aplicar»** -- la regla en sí no se puede leer: a algunas de sus condiciones o acciones les faltan piezas que MailCopilot necesita para ejecutarla, casi siempre porque lo que la creó (por ejemplo, un asistente de IA al que se le pidió configurar una regla) no terminó de escribirla correctamente. Abrir la regla muestra el mismo mensaje, y sus listas de condiciones y acciones aparecen vacías en el editor -- no hay nada que arreglar, solo reconstruirla desde cero.
- **«No se aplica»** -- la regla se puede leer, pero MailCopilot no puede justificar ejecutarla tal como está escrita. Esto cubre las dos situaciones descritas arriba: una condición que coincide con un campo que MailCopilot no guarda para el correo en caché (como **Cc**), que nunca puede comprobarse de verdad; o una acción destructiva -- **Mover a papelera**, **Marcar como spam**, **Archivar** o **Mover a carpeta** -- condicionada al nombre visible del remitente (**Remitente — nombre visible** o el campo obsoleto **Remitente — nombre o dirección**), que el remitente puede fijar como quiera, así que no puede justificar la acción (consulta «El nombre visible se puede falsificar» más arriba).

Si una regla cumple ambos veredictos, **«No se puede aplicar»** tiene prioridad -- las etiquetas nunca aparecen juntas; solo se muestra el rótulo de regla ilegible.

Al pasar el cursor por encima de cualquiera de las dos etiquetas, una información sobre herramientas muestra en una línea el motivo del rechazo; si llegas a la etiqueta con el teclado, esa información no aparece. En **«No se aplica»**, el motivo forma parte además de lo que un lector de pantalla anuncia para la etiqueta, y la etiqueta misma es un botón: al hacer clic en ella se abre la regla en el editor para que puedas corregir la condición o acción que lo causa. **«No se puede aplicar»** es solo un rótulo, no un botón: no hay nada que señalarte en el editor, así que abre esa regla con el botón de edición (lápiz) de su fila. Una regla en cualquiera de estos dos estados permanece sin cambios en tu lista hasta que la corrijas -- la casilla junto a ella sigue activándola o desactivándola, y eliminarla de la lista siempre funciona, pero la regla en sí no hace nada mientras esté marcada así.

## Probar reglas

Antes de guardar una regla, haz clic en **«Probar en correos existentes»** para previsualizar cuáles de tus correos recientes de la bandeja de entrada coincidirían con las condiciones. La vista previa revisa hasta 500 correos de la bandeja de entrada ya descargados a este dispositivo y muestra hasta 20 coincidencias -- es una comprobación rápida, no una búsqueda exhaustiva en todo tu buzón. En una regla limitada a una sola cuenta, esos son tus correos más recientes; en una regla para todas las cuentas, los 500 revisados proceden del conjunto de tus cuentas, pero no son necesariamente los más recientes en general. El correo más antiguo y el que aún no se ha descargado a este dispositivo no se incluyen.

## Aplicar a correos existentes

Marca **«Aplicar a correos existentes en la bandeja de entrada»** al guardar una regla para ejecutarla de inmediato sobre el correo que ya tienes. Esto alcanza hasta 1000 correos de la bandeja de entrada ya descargados a este dispositivo -- en una regla limitada a una sola cuenta, tus correos más recientes de ese tipo; en una regla para todas las cuentas, hasta 1000 correos procedentes del conjunto de tus cuentas, no necesariamente los más recientes en general. No llega más atrás en tu historial de correo en el servidor, y solo cubre la bandeja de entrada, no otras carpetas. Si una acción falla, solo se omite esa acción -- las demás acciones de la misma regla se siguen ejecutando sobre ese correo, y el resto del proceso se completa igualmente. Una regla con una condición que MailCopilot no puede comprobar, o en la que el nombre visible (o el campo obsoleto) condiciona una acción de movimiento o destructiva, también se rechaza aquí -- consulta «Condiciones» más arriba.

## Solo correo nuevo

Las reglas actúan sobre un correo nuevo en cuanto llega a tu dispositivo, sin importar por qué vía llegó -- una notificación push, una sincronización periódica o una página con correos más recientes que los que ya habías visto. Antes, la vía por la que llegaba un mensaje podía influir en si una regla lo detectaba o no, y algunos correos se perdían por eso; ese hueco ya no existe. Sin embargo, desplazarte hacia atrás para cargar páginas más antiguas no hace que esos correos antiguos pasen por las reglas -- eso es intencional, el mismo comportamiento de «no explorar el historial» descrito más abajo, no un hueco que haya quedado sin cerrar.

Aun así, esta garantía para el correo nuevo no es absoluta en todos los casos: un correo cuya acción falla tres intentos seguidos (por ejemplo, por una conexión interrumpida) se descarta definitivamente -- MailCopilot lo omite y sigue adelante en esa carpeta, así que un reinicio posterior no lo hará volver. Lo que un reinicio sí reinicia es un contador que aún no ha llegado a tres: si la aplicación se reinicia antes de que un correo haya fallado tres veces seguidas, el conteo vuelve a empezar desde cero, de modo que una acción que sigue fallando por un motivo que no desaparece puede bloquear indefinidamente el procesamiento de una carpeta, sin llegar nunca a alcanzar de verdad ese límite de tres intentos.

Además, las reglas nunca exploran por sí solas el historial completo de una carpeta. Cada carpeta que MailCopilot ya conoce al iniciarse recibe un punto de partida de inmediato, antes de que ocurra ninguna sincronización -- una carpeta vacía recibe un punto de partida en cero, así que su primer correo se evalúa con normalidad; una carpeta que ya tiene correo en caché recibe un punto de partida posterior a ese correo, de modo que el correo existente no se incorpora, pero todo lo que llegue después sí. Una carpeta que solo aparece después de ese momento de inicio -- recién creada o a la que te acabas de suscribir -- se trata de otra manera: no se evalúa nada en ella hasta que MailCopilot la haya sincronizado una vez, y solo cuenta el correo que llega después de esa primera sincronización. Ocurre el mismo reinicio si el servidor llega a reiniciar la numeración de los mensajes de una carpeta (algo poco frecuente, pero que puede ocurrir tras ciertas migraciones del lado del servidor). Usa **«Aplicar a correos existentes en la bandeja de entrada»** (véase más arriba) si quieres que una regla también evalúe el correo que ya tienes.

## Prioridad de las reglas

Las reglas se evalúan en orden de prioridad (número menor = mayor prioridad). La prioridad se asigna automáticamente al crear la regla -- por ahora no hay forma de ajustarla desde el editor de reglas. Si dos reglas tienen la misma prioridad, no está definido cuál de ellas se evalúa primero.

## Reglas de IA

Si tienes un proveedor de IA configurado (consulta [Asistente de IA](../ai-assistant)), también puedes crear reglas basadas en IA. Las reglas de IA procesan los correos que no coinciden con ninguna regla estática.

Esto es distinto de pedirle al asistente, en el chat, que cree o modifique una regla por ti. Cuando haces eso, el asistente crea o modifica una regla **estática** -- la descrita más arriba, con sus propias condiciones y acciones -- y se le aplican íntegramente todas las restricciones descritas antes: no puede crear una condición sobre el Cc, porque MailCopilot no lo guarda; no puede condicionar una regla que mueve, envía a la papelera, archiva o marca correo como spam al nombre visible del remitente, solo a **Remitente — dirección**; y si devuelve una regla que MailCopilot no puede aplicar por algún otro motivo, la regla no se guarda -- pídele que lo intente de nuevo, o crea tú mismo la regla en el editor. Una **regla de IA**, de la que trata el resto de esta sección, es una entidad completamente distinta: en lugar de condiciones, tiene un prompt que describe lo que quieres con tus propias palabras, más una lista de acciones que le permites realizar a la IA.

### Cómo funcionan las reglas de IA

1. Escribes un prompt que describe cómo ordenar los correos (por ejemplo, «Archivar boletines, mover correos de reclutadores a la carpeta Empleo»).
2. Eliges qué acciones puede realizar la IA.
3. Estableces un límite de presupuesto diario para controlar los costos.
4. La IA evalúa los correos no procesados en lotes. Aplica automáticamente las acciones reversibles (archivar, mover, marcar como leído, destacar); para **Mover a papelera** o **Marcar como spam**, no toca el correo en absoluto -- en su lugar registra la acción propuesta como entrada en el registro.

Las acciones de las reglas de IA se registran para que puedas revisar qué acción se aplicó o propuso para cada correo.

Una regla de IA no tiene condiciones que restringir, así que las reglas sobre el Cc y sobre la dirección del remitente descritas antes para las reglas estáticas simplemente no se le aplican -- no hay nada parecido a una condición sobre lo que puedan aplicarse. Su protección funciona de otra forma: tú eliges qué acciones puede realizar en absoluto (ver más abajo); de esas, todas se aplican automáticamente excepto **Mover a papelera** y **Marcar como spam** -- consulta «Las acciones destructivas requieren revisión» más abajo para saber qué pasa con esas dos.

### Las nuevas reglas de IA empiezan desactivadas

Una regla de IA recién creada está **desactivada de forma predeterminada**. Active **«Activada»** en la regla una vez que haya revisado su prompt y las acciones permitidas, para empezar a aplicarla al correo entrante. Esto evita que una regla actúe sobre su bandeja de entrada antes de que usted confirme que se comporta como espera.

### Límite de reglas activadas por cuenta

Puede activar como máximo **20 reglas de IA por cuenta** (las reglas globales, que se aplican a todas las cuentas, cuentan para el límite de cada cuenta). Si intenta activar una regla por encima de este límite, la aplicación muestra un mensaje y la regla permanece desactivada — desactive primero otra regla. Este límite mantiene el procesamiento en segundo plano rápido y predecible: todas las reglas activadas de una cuenta se evalúan juntas en una sola pasada.

### Las acciones destructivas requieren revisión

Las acciones reversibles -- archivar, mover a carpeta, marcar como leído, destacar -- se aplican automáticamente cuando coincide una regla de IA. **Mover a papelera** y **Marcar como spam** nunca se aplican automáticamente: el correo no se toca, y la IA registra la acción propuesta como una entrada en el registro de acciones de la regla, de modo que nada se elimina ni se marca como spam solo por decisión de una regla de IA. No hay un botón para llevar a cabo una propuesta registrada -- si estás de acuerdo con ella, actúa tú mismo sobre ese correo de la forma habitual (desde la lista de mensajes o su menú contextual).

### Las reglas solo ven su propia cuenta

Una regla de IA asociada a una cuenta específica solo evalúa y actúa sobre el correo de esa cuenta. Nunca ve ni afecta a los mensajes de sus otras cuentas.
