---
sidebar_position: 5
title: Templates
---

# Templates

The Templates tab in Settings lets you create, edit, and delete reusable message templates.

## Creating a Template

1. Go to **Settings > Templates**.
2. Click the **Add template** button.
3. Fill in the fields:
   - **Name** -- a short name to identify the template (e.g., "Quick follow-up").
   - **Subject** -- the email subject line, e.g., `Re: {subject}` (optional).
   - **Body** -- the message text, e.g., `Hi {name}, thanks for reaching out…`
   - **Shortcut** -- an optional short keyword to quickly find the template.
4. Click **Save**.

## Editing a Template

Click the **pencil icon** next to a template to edit it. After making changes, click **Save** to update the template.

## Deleting a Template

Click the **trash icon** next to a template to delete it. Deleted templates cannot be recovered.

## Template Variables

You can use variables in your template's subject and body. These variables are automatically replaced when you apply the template in the compose window:

| Variable | Replaced with |
|----------|---------------|
| `{name}` | The recipient's name |
| `{email}` | The recipient's email address |
| `{date}` | Today's date |

### Example

**Template body:**
```
Dear {name},

Thank you for your email. I will review it and get back to you shortly.

Best regards
```

When applied to a message addressed to "Alice Smith", the `{name}` variable will be replaced with "Alice Smith".

## Using Templates

To use a template when composing a message, see [Composing Emails > Using Templates](../usage/composing-emails#using-templates).
