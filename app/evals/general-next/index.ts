import { scenario as scenario01 } from './scenarios/01-greeting'
import { scenario as scenario02 } from './scenarios/02-graph-count'
import { scenario as scenario03 } from './scenarios/03-web-read'
import { scenario as scenario04 } from './scenarios/04-library-docs'
import { scenario as scenario05 } from './scenarios/05-memory-lookup'
import { scenario as scenario06 } from './scenarios/06-read-only'
import { scenario as scenario07 } from './scenarios/07-follow-up-success'
import { scenario as scenario08 } from './scenarios/08-follow-up-failure'
import { scenario as scenario09 } from './scenarios/09-upload-summary'
import { scenario as scenario10 } from './scenarios/10-csv-analysis'
import { scenario as scenario11 } from './scenarios/11-mail-to-file'
import { scenario as scenario12 } from './scenarios/12-retrieve-citation'
import { scenario as scenario13 } from './scenarios/13-two-sources'
import { scenario as scenario14 } from './scenarios/14-analysis-index-follow-up'
import { scenario as scenario15 } from './scenarios/15-graph-file-summary'
import { scenario as scenario16 } from './scenarios/16-graph-files-analysis'

import { scenario as scenario17 } from './scenarios/17-mail-analysis-follow-up'
// Per-user memory (withMemory): the store step, the confirm flow, recall and true negatives.
import { scenario as scenario19 } from './scenarios/19-memory-save-recall'
import { scenario as scenario20 } from './scenarios/20-memory-reinforce'
import { scenario as scenario21 } from './scenarios/21-memory-update'
import { scenario as scenario22 } from './scenarios/22-memory-stale'
import { scenario as scenario23 } from './scenarios/23-memory-discard'
import { scenario as scenario24 } from './scenarios/24-memory-isolation'
import { scenario as scenario25 } from './scenarios/25-memory-small-talk'
import { scenario as scenario26 } from './scenarios/26-memory-question'
import { scenario as scenario27 } from './scenarios/27-memory-hypothetical'
import { scenario as scenario28 } from './scenarios/28-memory-tool-instruction'
import { scenario as scenario29 } from './scenarios/29-memory-assistant-fact'
import { scenario as scenario30 } from './scenarios/30-memory-secret'
import { scenario as scenario31 } from './scenarios/31-memory-third-person'
// The organizational-knowledge hook (slice 7): the true negatives and three positives.
import { scenario as scenario32 } from './scenarios/32-org-new-project'
import { scenario as scenario33 } from './scenarios/33-org-deadline-on-existing'
import { scenario as scenario34 } from './scenarios/34-org-coordinator-replaced'
import { scenario as scenario35 } from './scenarios/35-org-small-talk'
import { scenario as scenario36 } from './scenarios/36-org-question'
import { scenario as scenario37 } from './scenarios/37-org-hypothetical'
import { scenario as scenario38 } from './scenarios/38-org-opinion'
import { scenario as scenario39 } from './scenarios/39-org-personal-preference'
import { scenario as scenario40 } from './scenarios/40-org-office-trivia'
import { scenario as scenario41 } from './scenarios/41-org-member-health'
import { scenario as scenario42 } from './scenarios/42-org-mail-injection'
import { scenario as scenario43 } from './scenarios/43-org-rumour'
import { scenario as scenario44 } from './scenarios/44-onboarding'
// The turn clock: today's date and "this afternoon" in the user's time zone.
import { scenario as scenario45 } from './scenarios/45-today-calendar-afternoon'
import { scenario as scenario46 } from './scenarios/46-retry-different-target'
import { scenario as scenario47 } from './scenarios/47-follow-up-documents-query'
// #1032: route results that feed each other, and the writer's evidence of them.
import { scenario as scenario48 } from './scenarios/48-person-files-document'
import { scenario as scenarioTn35 } from './scenarios/tn35-remember-preference'
import { scenario as scenarioTn36 } from './scenarios/tn36-what-do-you-remember'
import { scenario as scenarioTn41 } from './scenarios/tn41-other-users-conversations'
import { scenario as scenarioTn58 } from './scenarios/tn58-other-owner-memory'

export const scenarios = [
  scenario01,
  scenario02,
  scenario03,
  scenario04,
  scenario05,
  scenario06,
  scenario07,
  scenario08,
  scenario09,
  scenario10,
  scenario11,
  scenario12,
  scenario13,
  scenario14,
  scenario15,
  scenario16,
  scenario17,
  scenario19,
  scenario20,
  scenario21,
  scenario22,
  scenario23,
  scenario24,
  scenario25,
  scenario26,
  scenario27,
  scenario28,
  scenario29,
  scenario30,
  scenario31,
  scenario32,
  scenario33,
  scenario34,
  scenario35,
  scenario36,
  scenario37,
  scenario38,
  scenario39,
  scenario40,
  scenario41,
  scenario42,
  scenario43,
  scenario44,
  scenario45,
  scenario46,
  scenario47,
  scenario48,
  scenarioTn35,
  scenarioTn36,
  scenarioTn41,
  scenarioTn58,
]
