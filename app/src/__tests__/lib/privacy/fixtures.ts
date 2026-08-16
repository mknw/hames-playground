/**
 * Realistic Microsoft Graph payloads for the pseudonymisation tests.
 *
 * Two families, deliberately:
 *  - **raw Graph resources** (message, event, driveItem, person, chatMessage) —
 *    the shapes documented in `docs/graph-api-notes.md`, nested identity fields
 *    and all;
 *  - **the app's own compact projections** — what `app-tools/graph.server.ts`
 *    actually hands the controller (`shapeMessages`, `shapeEvents`,
 *    `shapeSharedInsight`, `shapeAttachmentMessage`, `shapeMe`), where a person
 *    has been flattened to a single string.
 *
 * Body text is Dutch and French, with names used mid-sentence and inflected,
 * because that is what this mailbox looks like and because it is the case an
 * English-trained NER model handles worst.
 *
 * Not real people: the addresses are on `dtsc.be` / `partner.example` and the
 * names are invented.
 */

/** A received message: sender, two recipients, a cc, a reply-to, Dutch body. */
export const graphMessage = {
  id: 'AAMkAGI2THVSAAA=',
  subject: 'Offerte Van Damme — feedback gevraagd',
  receivedDateTime: '2026-08-11T07:42:11Z',
  isRead: false,
  hasAttachments: true,
  bodyPreview:
    'Beste Michael, Jan Van Damme heeft de offerte doorgestuurd naar Sofie Vermeulen. ' +
    'Sofie kijkt ernaar voor vrijdag; Jan wacht op je antwoord. Michaels planning blijft ongewijzigd.',
  body: {
    contentType: 'text',
    content:
      'Beste Michael, Jan Van Damme heeft de offerte doorgestuurd naar Sofie Vermeulen. ' +
      'Sofie kijkt ernaar voor vrijdag; Jan wacht op je antwoord. ' +
      'Antwoorden mag rechtstreeks aan jan.vandamme@dtsc.be.',
  },
  from: {
    emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' },
  },
  sender: {
    emailAddress: { name: 'Jan Van Damme', address: 'Jan.VanDamme@dtsc.be' },
  },
  toRecipients: [
    { emailAddress: { name: 'Michael Accetto', address: 'michael.accetto@dtsc.be' } },
    { emailAddress: { name: 'Sofie Vermeulen', address: 'sofie.vermeulen@dtsc.be' } },
  ],
  ccRecipients: [{ emailAddress: { name: 'José Müller', address: 'jose.muller@partner.example' } }],
  replyTo: [{ emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } }],
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAA%3D&viewmodel=ReadMessageItem',
}

/** An HTML-bodied message — the common case for `body.content`, and the one a
 *  naive string replace corrupts. Note the identity inside `href="mailto:…"`
 *  and inside a `title=` attribute, and the French prose. */
export const graphHtmlMessage = {
  id: 'AAMkAGI2THVSAAB=',
  subject: 'Devis — relance',
  from: {
    emailAddress: { name: 'Élodie Lefèvre', address: 'elodie.lefevre@partner.example' },
  },
  toRecipients: [{ emailAddress: { name: 'Michael Accetto', address: 'michael.accetto@dtsc.be' } }],
  body: {
    contentType: 'html',
    content:
      '<html><head><style>p { margin: 0; }</style></head><body>' +
      '<p>Bonjour Michael,</p>' +
      '<p>Élodie Lefèvre a transféré le devis à <b>José Müller</b> hier soir. ' +
      'Merci de répondre à <a href="mailto:elodie.lefevre@partner.example" ' +
      'title="Élodie Lefèvre">Élodie</a> avant vendredi.</p>' +
      '<p>Bien à vous,<br/>Élodie</p></body></html>',
  },
}

/** A calendar event: organizer plus three attendees, one of them a room
 *  (`type: 'resource'`) whose `emailAddress` is not a person's. */
export const graphEvent = {
  id: 'AAMkAGEVENT=',
  subject: 'Review offerte met Jan Van Damme',
  start: { dateTime: '2026-08-12T09:00:00.0000000', timeZone: 'Romance Standard Time' },
  end: { dateTime: '2026-08-12T09:30:00.0000000', timeZone: 'Romance Standard Time' },
  isAllDay: false,
  location: { displayName: 'Vergaderzaal Brussel' },
  bodyPreview: 'Sofie Vermeulen brengt de cijfers mee. Jan licht de marge toe.',
  organizer: {
    emailAddress: { name: 'Sofie Vermeulen', address: 'sofie.vermeulen@dtsc.be' },
  },
  attendees: [
    {
      type: 'required',
      status: { response: 'accepted', time: '2026-08-10T10:00:00Z' },
      emailAddress: { name: 'Michael Accetto', address: 'michael.accetto@dtsc.be' },
    },
    {
      type: 'required',
      status: { response: 'none', time: '0001-01-01T00:00:00Z' },
      emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' },
    },
    {
      type: 'resource',
      status: { response: 'none', time: '0001-01-01T00:00:00Z' },
      emailAddress: { name: 'Vergaderzaal Brussel', address: 'zaal.brussel@dtsc.be' },
    },
  ],
}

/** A driveItem as `/children` returns it: identity lives under `createdBy.user`
 *  and `lastModifiedBy.user`, and the person's name is in the filename and in
 *  the personal-site segment of the webUrl. */
export const graphDriveItem = {
  id: '01ABCDEF7890',
  name: 'Offerte Van Damme 2026.docx',
  size: 48213,
  webUrl:
    'https://dtsc-my.sharepoint.com/personal/jan_vandamme_dtsc_be/Documents/Offertes/Offerte%20Van%20Damme%202026.docx',
  lastModifiedDateTime: '2026-08-09T15:02:44Z',
  file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  createdBy: {
    user: {
      displayName: 'Jan Van Damme',
      email: 'jan.vandamme@dtsc.be',
      id: '9f3c0b1e-0000-4000-8000-abcdefabcdef',
    },
  },
  lastModifiedBy: {
    user: { displayName: 'Sofie Vermeulen', email: 'sofie.vermeulen@dtsc.be' },
  },
  parentReference: {
    driveId: 'b!driveid',
    id: '01PARENT',
    path: '/drives/b!driveid/root:/Offertes',
    siteId: 'dtsc.sharepoint.com,site-guid,web-guid',
  },
  shared: {
    scope: 'users',
    sharedBy: { user: { displayName: 'Jan Van Damme', email: 'jan.vandamme@dtsc.be' } },
    sharedDateTime: '2026-08-09T15:04:00Z',
  },
}

/** A `person` resource: the name is at the root and the address is one level
 *  down in `scoredEmailAddresses`. */
export const graphPerson = {
  id: '9f3c0b1e-0000-4000-8000-abcdefabcdef',
  displayName: 'Jan Van Damme',
  givenName: 'Jan',
  surname: 'Van Damme',
  scoredEmailAddresses: [{ address: 'jan.vandamme@dtsc.be', relevanceScore: 12.4 }],
  personType: { class: 'Person', subclass: 'OrganizationUser' },
}

/** A Teams `chatMessage`: identities sit under `from.user` and `mentions[]`. */
export const graphChatMessage = {
  id: '1723372931234',
  createdDateTime: '2026-08-11T08:02:11Z',
  from: { user: { displayName: 'Sofie Vermeulen', id: 'sofie-oid', userIdentityType: 'aadUser' } },
  body: {
    contentType: 'html',
    content: '<div>Michael, kan jij dit met Jan afstemmen?</div>',
  },
  mentions: [
    {
      id: 0,
      mentionText: 'Michael Accetto',
      mentioned: { user: { displayName: 'Michael Accetto', id: 'michael-oid' } },
    },
  ],
}

// ---------------------------------------------------------------------------
// The app's own compact projections — what the controller actually sees.
// ---------------------------------------------------------------------------

/** `graph_mail_recent` → `shapeMessages`. `from` is one flat string. */
export const compactMailResult = {
  unreadOnly: false,
  messages: [
    {
      subject: 'Offerte Van Damme — feedback gevraagd',
      from: 'Jan Van Damme',
      received: '2026-08-11T07:42:11Z',
      isRead: false,
      hasAttachments: true,
      preview: 'Beste Michael, Jan Van Damme heeft de offerte doorgestuurd naar Sofie Vermeulen.',
      webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAA%3D',
    },
    {
      subject: 'Planning week 33',
      from: 'sofie.vermeulen@dtsc.be',
      received: '2026-08-10T16:11:02Z',
      isRead: true,
      hasAttachments: false,
      preview: 'Sofie stuurt de planning door zodra Jan bevestigt.',
      webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAC%3D',
    },
  ],
}

/** `graph_calendar_today` → `shapeEvents`. `organizer` is one flat string. */
export const compactCalendarResult = {
  timeZone: 'Europe/Brussels',
  day: '2026-08-12',
  events: [
    {
      subject: 'Review offerte met Jan Van Damme',
      start: '2026-08-12T09:00:00.0000000',
      end: '2026-08-12T09:30:00.0000000',
      isAllDay: false,
      location: 'Vergaderzaal Brussel',
      organizer: 'Sofie Vermeulen',
      onlineMeetingUrl: null,
    },
  ],
}

/** `graph_files_shared` → `shapeSharedInsight`. Person is `shared_by`. */
export const compactSharedResult = {
  items: [
    {
      name: 'Offerte Van Damme 2026.docx',
      kind: 'file',
      shared_by: 'Jan Van Damme',
      shared_when: '2026-08-09T15:04:00Z',
      how: 'Link',
      via: 'link',
      drive_id: 'b!driveid',
      item_id: '01ABCDEF7890',
      webUrl:
        'https://dtsc-my.sharepoint.com/personal/jan_vandamme_dtsc_be/Documents/Offertes/Offerte%20Van%20Damme%202026.docx',
    },
  ],
}

/** `graph_mail_attachments` → `shapeAttachmentMessage`. People are in `with[]`. */
export const compactAttachmentsResult = {
  direction: 'sent',
  messages: [
    {
      subject: 'Offerte voor Sofie',
      with: ['Sofie Vermeulen', 'Jan Van Damme'],
      date: '2026-08-08T11:20:00Z',
      attachments: [
        { name: 'Offerte Van Damme 2026.docx', size: 48213, contentType: 'application/msword' },
      ],
      webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAD%3D',
    },
  ],
}

/** `graph_me` → `shapeMe`. Flat, and the only place `givenName`/`surname`
 *  arrive as separate fields. */
export const compactMeResult = {
  displayName: 'Michael Accetto',
  givenName: 'Michael',
  surname: 'Accetto',
  userPrincipalName: 'michael.accetto@dtsc.be',
  mail: 'michael.accetto@dtsc.be',
  jobTitle: 'Solutions Architect',
  officeLocation: 'Brussel',
  preferredLanguage: 'nl-BE',
}
