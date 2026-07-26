import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/installation',
        'getting-started/adding-account',
      ],
    },
    {
      type: 'category',
      label: 'Usage',
      items: [
        'usage/interface-overview',
        'usage/reading-emails',
        'usage/composing-emails',
        'usage/folders',
      ],
    },
    {
      type: 'category',
      label: 'Settings',
      items: [
        'settings/general',
        'settings/productivity',
        'settings/signatures',
        'settings/identities',
        'settings/templates',
        'settings/mail-rules',
        'settings/folders-settings',
        'settings/about',
      ],
    },
    'ai-assistant',
    'keyboard-shortcuts',
    'faq',
    {
      type: 'category',
      label: 'Privacy',
      items: [
        'privacy/ai-data',
        'privacy/telemetry',
      ],
    },
    {
      type: 'category',
      label: 'Legal',
      items: [
        'legal/privacy-policy',
        'legal/terms-of-service',
      ],
    },
  ],
};

export default sidebars;
