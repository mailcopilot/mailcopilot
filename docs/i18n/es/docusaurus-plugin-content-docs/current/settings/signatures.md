---
sidebar_position: 3
title: Firmas
---

# Firmas

## Configurar una firma

Configura tu firma en **Configuracion > Firma**. La pestana «Firmas» edita la firma de la **identidad por defecto** de la cuenta seleccionada. Si tienes varias cuentas, escoge la cuenta en el desplegable superior; si la cuenta tiene identidades adicionales (direcciones «From» alternativas), cada una tiene su propia firma -- se editan en **Ajustes > Identities**.

## Escribir tu firma

Introduce el texto de la firma en el area de texto. Un formato habitual incluye:

```
--
Juan Perez
Ingeniero de software
ACME S.L.
juan.perez@example.com
```

El separador `--` es el delimitador de firma estandar reconocido por la mayoria de clientes de correo.

## Como funcionan las firmas

- Tu firma se **anade automaticamente** a los mensajes nuevos al abrir la ventana de redaccion.
- Las firmas **no** se anaden a las respuestas ni a los reenvios, para evitar duplicados.
- Si editas un borrador que ya tiene firma, la firma existente se conserva.
- La identidad por defecto de cada cuenta puede tener su propia firma; las identidades adicionales tienen tambien cada una su firma, editable en **Ajustes > Identities**.

## Eliminar una firma

Para eliminar una firma, vacia el area de texto en **Configuracion > Firma** y guarda.

## Firmas e identidades

Las firmas viven ahora por identidad, no por cuenta. La pestana **Firmas** de esta pagina edita la firma de la identidad por defecto de la cuenta. Si la cuenta tiene identidades adicionales (otras direcciones «From» en la misma cuenta, por ejemplo un alias personal o un alias de equipo), cada una tiene su propia firma -- editalas en **Ajustes > Identities**. Consulta [Identidades](./identities) para entender como funcionan las identidades y como la ventana de redaccion elige una al responder o redactar un nuevo mensaje.
