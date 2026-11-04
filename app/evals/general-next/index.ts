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
  scenarioTn35,
  scenarioTn36,
  scenarioTn41,
  scenarioTn58,
]
