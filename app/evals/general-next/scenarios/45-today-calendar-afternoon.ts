import { catalogueChecks } from '../catalogue-checks'
import type { ConversationScenario } from '../types'

// The turn clock (`RunFrame.clock`), fixed: 23:30Z on Wednesday 4 November is 00:30 on
// Thursday 5 November in Brussels, so an answer dated from UTC (or from nothing) is wrong.
// The calendar result deliberately carries NO date and no zone: the only source of
// "2026-11-05" and "Thursday" in the whole prompt is the CURRENT TIME block.
export const scenario: ConversationScenario = {
  id: '45-today-calendar-afternoon',
  title: 'Today’s date and this afternoon’s meetings, in the user’s time zone',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: ['What’s today’s date and what’s on my calendar this afternoon?'],
  expectedTools: ['graph_calendar_today'],
  expectedArgs: {
    graph_calendar_today: (args) =>
      Object.keys(args).every((key) => key === 'day_offset') &&
      (args.day_offset === undefined || Number(args.day_offset) === 0),
  },
  expectedRoutes: ['office-data'],
  // The local date is graded by the catalogue's answerMatches, which accepts it written
  // out in words as well ("Thursday, November 5, 2026"): the same correct answer.
  answerIncludes: ['Thursday', 'Design review'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  clock: { instant: '2026-11-04T23:30:00Z', timeZone: 'Europe/Brussels' },
  toolData: {
    graph_calendar_today: {
      events: [
        { subject: 'Standup', start: '09:30', end: '09:45', organizer: 'Mira Cedar' },
        { subject: 'Design review', start: '14:00', end: '15:00', organizer: 'Oren Vale' },
      ],
    },
  },
  ...catalogueChecks('45-today-calendar-afternoon'),
}
