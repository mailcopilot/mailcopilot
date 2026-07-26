import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'MailCopilot',
  tagline: 'Smart email client for desktop',
  favicon: 'img/favicon.png',

  url: 'https://mailcopilot.io',
  baseUrl: process.env.BASE_URL || '/docs/',

  organizationName: 'mailcopilot',
  projectName: 'mailcopilot-docs',

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ru', 'fr', 'de', 'es', 'it'],
    localeConfigs: {
      en: { label: 'English', direction: 'ltr', htmlLang: 'en-US' },
      ru: { label: 'Русский', direction: 'ltr', htmlLang: 'ru' },
      fr: { label: 'Français', direction: 'ltr', htmlLang: 'fr' },
      de: { label: 'Deutsch', direction: 'ltr', htmlLang: 'de' },
      es: { label: 'Español', direction: 'ltr', htmlLang: 'es' },
      it: { label: 'Italiano', direction: 'ltr', htmlLang: 'it' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: 'MailCopilot',
      logo: {
        alt: 'MailCopilot Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          href: 'https://mailcopilot.io',
          label: 'mailcopilot.io',
          position: 'right',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Getting Started',
              to: '/getting-started/installation',
            },
            {
              label: 'User Guide',
              to: '/usage/interface-overview',
            },
          ],
        },
        {
          title: 'Legal',
          items: [
            {
              label: 'Privacy Policy',
              to: '/legal/privacy-policy',
            },
            {
              label: 'Terms of Service',
              to: '/legal/terms-of-service',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Website',
              href: 'https://mailcopilot.io',
            },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} MailCopilot.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
    colorMode: {
      defaultMode: 'light',
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
