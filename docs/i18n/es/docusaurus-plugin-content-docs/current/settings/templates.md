---
sidebar_position: 5
title: Plantillas
---

# Plantillas

La pestana Plantillas en Configuracion te permite crear, editar y eliminar plantillas de mensajes reutilizables.

## Crear una plantilla

1. Ve a **Configuracion > Plantillas**.
2. Haz clic en el boton **Agregar plantilla**.
3. Completa los campos:
   - **Nombre** -- un nombre corto para identificar la plantilla (p. ej., "Seguimiento rapido").
   - **Asunto** -- el asunto del correo, p. ej., `Re: {subject}` (opcional).
   - **Cuerpo** -- el texto del mensaje, p. ej., `Hola {name}, gracias por escribir…`
   - **Atajo** -- una palabra clave opcional para encontrar rapidamente la plantilla.
4. Haz clic en **Guardar**.

## Editar una plantilla

Haz clic en el **icono de lapiz** junto a una plantilla para editarla. Despues de hacer los cambios, haz clic en **Guardar** para actualizar la plantilla.

## Eliminar una plantilla

Haz clic en el **icono de papelera** junto a una plantilla para eliminarla. Las plantillas eliminadas no se pueden recuperar.

## Variables de plantilla

Puedes usar variables en el asunto y el cuerpo de tu plantilla. Estas variables se reemplazan automaticamente cuando aplicas la plantilla en la ventana de redaccion:

| Variable | Se reemplaza por |
|----------|-----------------|
| `{name}` | El nombre del destinatario |
| `{email}` | La direccion de correo del destinatario |
| `{date}` | La fecha de hoy |

### Ejemplo

**Cuerpo de la plantilla:**
```
Estimado/a {name},

Gracias por tu correo. Lo revisare y te respondere a la brevedad.

Saludos cordiales
```

Cuando se aplica a un mensaje dirigido a "Alice Smith", la variable `{name}` se reemplazara con "Alice Smith".

## Usar plantillas

Para usar una plantilla al redactar un mensaje, consulta [Redactar correos > Usar plantillas](../usage/composing-emails#usar-plantillas).
