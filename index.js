// Good Enough Golfers
// Brad Buchanan, 2017
// MIT License (see ./LICENSE)
//
// Good-Enough Golfers is a near-solver for a class of scheduling
// problems including the [Social Golfer Problem][1] and
// [Kirkman's Schoolgirl Problem][2]. The goal is to schedule g x p
// players into g groups of size p for w weeks such that no two
// players meet more than once.
//
// [1]: http://mathworld.wolfram.com/SocialGolferProblem.html
// [2]: http://mathworld.wolfram.com/KirkmansSchoolgirlProblem.html
//
// Real solutions to these problems can be extremely slow, but
// approximations are fast and often good enough for real-world
// purposes.  Good-Enough Golfers uses a genetic algorithm to
// generate near-solutions to this class of problems, and has the
// ability to consider additional weighted constriants, making it
// useful for real-world situations such as assigning students to
// discussion groups.
//
// Besides index.html itself, this file is the entry point for the
// application and is a good place to start to understand the flow
// of control. However, it does not contain the actual solver. See
// lib/geneticSolver.js if you want to jump to the actual algorithm.
//
// We begin by declaring and initializing some page-global variables.
//
// These are references to the inputs column and the outputs column,
// and an object to organize references to individual controls, so
// that working with the DOM is more readable later.
let appDiv, controlsDiv, resultsShellDiv, resultsDiv
let controls = {}

// These variables hold the state of the input controls, which are
// also the parameters we will pass into the solver.
let groups = 0
let totalPlayers = 0
let forRounds = 0

// Each time we kick off the solver we will mark the time, so that
// we can eaily report the time required to compute the solution.
let startTime
let lastComputationSeconds = null

// This variable holds the last result returned by the solver,
let lastResults
let currentRoundIndex = 0
let currentViewMode = 'tables'
let sidebarCollapsed = false
let themePreference = 'system'

const GROUP_MEMBER_TILE_SIZE = 40
const GROUP_MEMBER_GAP = 8
const GROUP_CARD_PADDING = 24
const GROUP_CARD_GAP = 14
const PARTICIPANT_ASSIGNMENT_COLUMN_WIDTH = 128
const PARTICIPANT_ASSIGNMENT_COLUMN_GAP = 12
const RESULTS_PANEL_HORIZONTAL_PADDING = 44
const RESULTS_MIN_WIDTH = 720

// Next we launch a web worker which is responsible for the slow job
// of actually computing a solution.
//
// Web workers are a simple way to do work in a background thread.
// This gets the solver work out of the UI thread (this one) and
// keeps the interface feeling responsive while a solution is being
// computed.
//
// See https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
const myWorker = new Worker('lib/worker.js');

// The init() function is called after the DOM is loaded. It prepares
// the application by setting up event handlers and an initial state
// and calling for an initial solution.
function init() {
  myWorker.addEventListener('message', onResults, false);
  myWorker.addEventListener('error', onWorkerError, false);
  myWorker.addEventListener('messageerror', onWorkerMessageError, false);

  appDiv = document.getElementById('app')
  controlsDiv = document.getElementById('controls')
  resultsShellDiv = document.getElementById('resultsShell')
  resultsDiv = document.getElementById('results')

  controls.recomputeButton = controlsDiv.querySelector('#recomputeButton')
  controls.groupsBox = controlsDiv.querySelector('#groupsBox')
  controls.groupsSlider = controlsDiv.querySelector('#groupsSlider')
  controls.totalPlayersBox = controlsDiv.querySelector('#totalPlayersBox')
  controls.totalPlayersSlider = controlsDiv.querySelector('#totalPlayersSlider')
  controls.playersPerGroupValue = controlsDiv.querySelector('#playersPerGroupValue')
  controls.forRoundsBox = controlsDiv.querySelector('#forRoundsBox')
  controls.forRoundsSlider = controlsDiv.querySelector('#forRoundsSlider')
  controls.tableViewButton = controlsDiv.querySelector('#tableViewButton')
  controls.participantViewButton = controlsDiv.querySelector('#participantViewButton')
  controls.sidebarToggle = document.getElementById('sidebarToggle')
  controls.sunToggle = document.getElementById('sunToggle')
  controls.viewModeToggle = document.getElementById('viewModeToggle')

  // User input controls
  controls.recomputeButton.onclick = recomputeResults;
  controls.groupsSlider.oninput = onSliderMoved
  controls.totalPlayersSlider.oninput = onSliderMoved
  controls.forRoundsSlider.oninput = onSliderMoved
  controls.groupsBox.oninput = onSliderLabelEdited
  controls.totalPlayersBox.oninput = onSliderLabelEdited
  controls.forRoundsBox.oninput = onSliderLabelEdited
  controls.tableViewButton.onclick = () => setViewMode('tables')
  controls.participantViewButton.onclick = () => setViewMode('participants')
  controls.sidebarToggle.onclick = toggleSidebar
  controls.sunToggle.onclick = toggleTheme
  controls.viewModeToggle.onclick = toggleViewMode
  window.addEventListener('resize', renderResults)
  if (window.matchMedia) {
    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    if (colorSchemeQuery.addEventListener) {
      colorSchemeQuery.addEventListener('change', onSystemThemeChanged)
    } else if (colorSchemeQuery.addListener) {
      colorSchemeQuery.addListener(onSystemThemeChanged)
    }
  }

  try {
    loadStateFromLocalStorage()
  } catch (err) {
    console.info('Failed to load previous state');
  }

  onSliderLabelEdited()
  syncViewModeControls()
  syncSidebarControls()
  syncThemeControls()

  if (lastResults) {
    renderResults()
  } else {
    recomputeResults()
  }
}

function onResults(e) {
  lastResults = e.data
  if (lastResults.done && startTime) {
    lastComputationSeconds = Math.round((Date.now() - startTime) / 100) / 10
  }
  currentRoundIndex = Math.min(currentRoundIndex, Math.max(lastResults.rounds.length - 1, 0))
  renderResults()
  if (lastResults.done) {
    saveStateToLocalStorage()
    enableControls()
  }
}

function onWorkerError(err) {
  console.error('Worker failed while computing results', err)
  lastResults = null
  resultsDiv.textContent = 'Failed to compute results. Check the browser console for details.'
  enableControls()
}

function onWorkerMessageError(err) {
  console.error('Worker failed to deserialize results', err)
  lastResults = null
  resultsDiv.textContent = 'Failed to compute results. Check the browser console for details.'
  enableControls()
}

function recomputeResults() {
  if (!hasValidConfiguration()) return

  startTime = Date.now();
  lastComputationSeconds = null
  currentRoundIndex = 0
  lastResults = null;
  renderResults()
  disableControls()
  myWorker.postMessage({
    groups,
    totalPlayers,
    forRounds,
    withGroupLeaders: false,
    forbiddenPairs: [],
    discouragedGroups: []
  })
}

// Every time we finish computing results we save the solution and and the
// input parameters that produced it to local storage. Whenever the user
// returns to the page we restore the latest solution. This would be helpful
// to teachers that need an updated configuration for the same class.
function saveStateToLocalStorage() {
  localStorage.setItem('appState', JSON.stringify({
    groups,
    totalPlayers,
    forRounds,
    lastComputationSeconds,
    currentViewMode,
    sidebarCollapsed,
    themePreference,
    lastResults
  }))
}

// When we load state on page load, we pull state from local storage and
// (mostly) write the state directly to the page controls. Then the normal
// initialization process will pick up the state from the controls.
// The one exception is that we load lastResults directly into the relevant
// variable, because it doesn't have a corresponding control on the page.
// This method will throw if a past state is not found in local storage or
// if we fail to deserialize it for some reason.
function loadStateFromLocalStorage() {
  const state = JSON.parse(localStorage.getItem('appState'))
  if (!state) throw new Error('Failed to load stored state')

  controls.groupsBox.value = state.groups
  controls.totalPlayersBox.value = state.totalPlayers || state.playerNames?.length || (state.groups * state.ofSize)
  controls.forRoundsBox.value = state.forRounds
  lastComputationSeconds = state.lastComputationSeconds ?? null
  currentViewMode = state.currentViewMode || 'tables'
  sidebarCollapsed = !!state.sidebarCollapsed
  themePreference = state.themePreference === 'dark' || state.themePreference === 'light'
    ? state.themePreference
    : 'system'
  lastResults = state.lastResults
  currentRoundIndex = 0
}

function onSliderMoved() {
  groups = parseInt(controls.groupsSlider.value, 10)
  totalPlayers = parseInt(controls.totalPlayersSlider.value, 10)
  forRounds = parseInt(controls.forRoundsSlider.value, 10)

  // Update labels
  controls.groupsBox.value = groups
  controls.totalPlayersBox.value = totalPlayers
  controls.forRoundsBox.value = forRounds
  syncGroupSplitDisplay()
}

function onSliderLabelEdited() {
  groups = readWholeNumber(controls.groupsBox.value)
  totalPlayers = readWholeNumber(controls.totalPlayersBox.value)
  forRounds = readWholeNumber(controls.forRoundsBox.value)

  controls.groupsSlider.max = Math.max(groups, controls.groupsSlider.max);
  controls.totalPlayersSlider.max = Math.max(totalPlayers, controls.totalPlayersSlider.max);
  controls.forRoundsSlider.max = Math.max(forRounds, controls.forRoundsSlider.max);
  
  controls.groupsSlider.value = groups
  controls.totalPlayersSlider.value = Math.min(controls.totalPlayersSlider.max, totalPlayers);
  controls.forRoundsSlider.value = Math.min(controls.forRoundsSlider.max, forRounds);
  syncGroupSplitDisplay()
}

function disableControls() {
  controls.recomputeButton.disabled = true
  controls.groupsBox.disabled = true
  controls.groupsSlider.disabled = true
  controls.totalPlayersBox.disabled = true
  controls.totalPlayersSlider.disabled = true
  controls.forRoundsBox.disabled = true
  controls.forRoundsSlider.disabled = true
  controls.tableViewButton.disabled = true
  controls.participantViewButton.disabled = true
  
  // Show spinner
  controls.recomputeButton.innerHTML = '&nbsp;<span class="spinner"></span>'
}

function enableControls() {
  controls.groupsBox.disabled = false
  controls.groupsSlider.disabled = false
  controls.totalPlayersBox.disabled = false
  controls.totalPlayersSlider.disabled = false
  controls.forRoundsBox.disabled = false
  controls.forRoundsSlider.disabled = false
  controls.tableViewButton.disabled = false
  controls.participantViewButton.disabled = false
  
  // Hide spinner
  controls.recomputeButton.innerHTML = 'Recompute!'
  syncGroupSplitDisplay()
  syncViewModeControls()
}

function hasValidConfiguration() {
  return groups > 0 && totalPlayers > 0
}

function readWholeNumber(value) {
  const parsed = Math.abs(parseInt(value, 10))
  return Number.isNaN(parsed) ? 0 : Math.min(999, parsed)
}

function groupSizes() {
  if (!hasValidConfiguration()) return []

  const baseSize = Math.floor(totalPlayers / groups)
  const largerGroupCount = totalPlayers % groups
  return Array.from({length: groups}, (_, groupIndex) =>
    baseSize + (groupIndex < largerGroupCount ? 1 : 0)
  )
}

function syncGroupSplitDisplay() {
  const validConfiguration = hasValidConfiguration()

  if (validConfiguration) {
    const averageGroupSize = totalPlayers / groups
    const evenlyDistributed = totalPlayers % groups === 0
    const displayedGroupSize = Number.isInteger(averageGroupSize)
      ? `${averageGroupSize}`
      : averageGroupSize.toFixed(1).replace(/\.0$/, '').replace('.', ',')

    controls.playersPerGroupValue.textContent = evenlyDistributed
      ? `${displayedGroupSize} Teilnehmer pro Tisch`
      : `~${displayedGroupSize} Teilnehmer pro Tisch`
    controls.playersPerGroupValue.style.color = ''
  } else {
    controls.playersPerGroupValue.textContent = 'Bitte mindestens 1 Tisch und 1 Teilnehmer eingeben.'
    controls.playersPerGroupValue.style.color = '#a00'
  }

  controls.recomputeButton.disabled = !validConfiguration
}

function playerName(i) {
  return `Teilnehmer ${i+1}`
}

const OKABE_ITO_PALETTE = [
  '#000000',
  '#E69F00',
  '#56B4E9',
  '#009E73',
  '#F0E442',
  '#0072B2',
  '#D55E00',
  '#CC79A7'
]

function playerCountFromResults(results) {
  return results.rounds.reduce((highestPlayerIndex, round) =>
    round.reduce((roundHighestIndex, group) =>
      group.reduce((groupHighestIndex, playerIndex) =>
        Math.max(groupHighestIndex, playerIndex),
      roundHighestIndex),
    highestPlayerIndex),
  -1) + 1
}

function buildParticipantColorMap(results) {
  const playerCount = playerCountFromResults(results)
  return Array.from({length: playerCount}, (_, playerIndex) =>
    OKABE_ITO_PALETTE[playerIndex % OKABE_ITO_PALETTE.length]
  )
}

function participantTileTextColor(backgroundColor) {
  return backgroundColor.toUpperCase() === '#000000' ? '#ffffff' : '#111111'
}

function downloadCsv() {
  // Pivot results into a table that's easier to work with
  const roundNames = lastResults.rounds.map((_, i) => `Runde ${i + 1}`)
  const playerCount = playerCountFromResults(lastResults)
  
  // Stub out a row for each player
  const players = []
  for (let i = 0; i < playerCount; i++) {
    players.push([playerName(i)])
  }
  
  // Fill in assigned groups
  lastResults.rounds.forEach((round) => {
    round.forEach((group, j) => {
      group.forEach(playerIndex => {
        players[playerIndex].push(`Tisch ${j + 1}`)
      })
    })
  })
  
  // Build table
  const rows = [
    ['', ...roundNames],
    ...players
  ]
  // For debugging: console.table(rows);
  
  let csvContent = "data:text/csv;charset=utf-8," 
    + rows.map(e => e.join(",")).join("\n");
  
  const encodedUri = encodeURI(csvContent)
  const link = document.createElement("a")
  link.setAttribute("href", encodedUri)
  link.setAttribute("download", "golfer_solution.csv")
  document.body.appendChild(link)
  link.click()
}

function showPreviousRound() {
  if (!lastResults) return
  currentRoundIndex = Math.max(0, currentRoundIndex - 1)
  renderResults()
}

function showNextRound() {
  if (!lastResults) return
  currentRoundIndex = Math.min(lastResults.rounds.length - 1, currentRoundIndex + 1)
  renderResults()
}

function setViewMode(viewMode) {
  currentViewMode = viewMode
  syncViewModeControls()
  saveStateToLocalStorage()
  renderResults()
}

function syncViewModeControls() {
  controls.tableViewButton.classList.toggle('active', currentViewMode === 'tables')
  controls.participantViewButton.classList.toggle('active', currentViewMode === 'participants')
  controls.viewModeToggle.textContent = currentViewMode === 'tables' ? '웃' : '☷'
  controls.viewModeToggle.setAttribute(
    'aria-label',
    currentViewMode === 'tables' ? 'Zu Teilnehmeransicht wechseln' : 'Zu Tischansicht wechseln'
  )
}

function toggleViewMode() {
  setViewMode(currentViewMode === 'tables' ? 'participants' : 'tables')
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed
  syncSidebarControls()
  saveStateToLocalStorage()
  renderResults()
}

function syncSidebarControls() {
  appDiv.classList.toggle('sidebarCollapsed', sidebarCollapsed)
  controls.sidebarToggle.textContent = sidebarCollapsed ? '⚙' : '⬅'
}

function toggleTheme() {
  themePreference = resolvedThemeMode() === 'dark' ? 'light' : 'dark'
  syncThemeControls()
  saveStateToLocalStorage()
}

function syncThemeControls() {
  const activeThemeMode = resolvedThemeMode()
  document.body.classList.toggle('darkMode', activeThemeMode === 'dark')
  controls.sunToggle.textContent = activeThemeMode === 'dark' ? '☀' : '🌘︎'
  controls.sunToggle.setAttribute(
    'aria-label',
    activeThemeMode === 'dark' ? 'Zu hellem Modus wechseln' : 'Zu dunklem Modus wechseln'
  )
}

function resolvedThemeMode() {
  return themePreference === 'system' ? detectSystemThemeMode() : themePreference
}

function detectSystemThemeMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function onSystemThemeChanged() {
  if (themePreference === 'system') {
    syncThemeControls()
  }
}

function participantAssignmentsForRound(round) {
  const assignments = []
  round.forEach((group, groupIndex) => {
    group.forEach(personNumber => {
      assignments.push({
        participantIndex: parseInt(personNumber, 10),
        tableIndex: groupIndex
      })
    })
  })

  return assignments.sort((a, b) => a.participantIndex - b.participantIndex)
}

function renderRoundHeader(roundIndex) {
  const header = document.createElement('div')
  header.classList.add('roundHeader')

  const previousButton = document.createElement('button')
  previousButton.type = 'button'
  previousButton.classList.add('roundNavButton')
  previousButton.textContent = '←'
  previousButton.disabled = roundIndex === 0
  previousButton.onclick = showPreviousRound

  const nextButton = document.createElement('button')
  nextButton.type = 'button'
  nextButton.classList.add('roundNavButton')
  nextButton.textContent = '→'
  nextButton.disabled = roundIndex === lastResults.rounds.length - 1
  nextButton.onclick = showNextRound

  const titleWrap = document.createElement('div')
  titleWrap.classList.add('roundTitleWrap')

  const title = document.createElement('h1')
  title.textContent = `Runde ${roundIndex + 1}`

  const conflictScore = document.createElement('div')
  conflictScore.classList.add('conflictScore')
  conflictScore.textContent = `Conflict score: ${lastResults.roundScores[roundIndex]}`

  const roundCounter = document.createElement('div')
  roundCounter.classList.add('roundCounter')
  roundCounter.textContent = `${roundIndex + 1} / ${lastResults.rounds.length}`

  titleWrap.appendChild(title)
  titleWrap.appendChild(conflictScore)
  titleWrap.appendChild(roundCounter)

  header.appendChild(previousButton)
  header.appendChild(titleWrap)
  header.appendChild(nextButton)
  return header
}

function renderTableRound(round, participantColors) {
  const groupsViewport = document.createElement('div')
  groupsViewport.classList.add('groupsViewport')

  const groups = document.createElement('div')
  groups.classList.add('groups')
  applyTableColumns(groups, 1)

  round.forEach((group, groupIndex) => {
    const groupDiv = document.createElement('div')
    groupDiv.classList.add('group')
    const groupName = document.createElement('h2')
    groupName.textContent = `Tisch ${groupIndex + 1}`
    groupDiv.appendChild(groupName)

    const members = document.createElement('div')
    members.classList.add('groupMembers')
    group.sort((a, b) => parseInt(a) < parseInt(b) ? -1 : 1).forEach(personNumber => {
      const participantIndex = parseInt(personNumber, 10)
      const backgroundColor = participantColors[participantIndex]
      const member = document.createElement('div')
      member.classList.add('participantTile')
      member.textContent = `${participantIndex + 1}`
      member.style.backgroundColor = backgroundColor
      member.style.color = participantTileTextColor(backgroundColor)
      members.appendChild(member)
    })
    groupDiv.appendChild(members)
    groups.appendChild(groupDiv)
  })

  groupsViewport.appendChild(groups)
  return groupsViewport
}

function renderParticipantRound(round, participantColors) {
  const assignments = participantAssignmentsForRound(round)
  const participantListViewport = document.createElement('div')
  participantListViewport.classList.add('participantAssignmentsViewport')
  const participantList = document.createElement('div')
  participantList.classList.add('participantAssignments')
  applyParticipantColumns(participantList, 1, assignments.length)

  assignments.forEach(({participantIndex, tableIndex}) => {
    const row = document.createElement('div')
    row.classList.add('participantAssignmentRow')

    const backgroundColor = participantColors[participantIndex]

    const tile = document.createElement('div')
    tile.classList.add('participantTile')
    tile.textContent = `${participantIndex + 1}`
    tile.style.backgroundColor = backgroundColor
    tile.style.color = participantTileTextColor(backgroundColor)

    const tableBadge = document.createElement('div')
    tableBadge.classList.add('participantAssignmentTable')
    tableBadge.textContent = `Tisch ${tableIndex + 1}`

    row.appendChild(tile)
    row.appendChild(tableBadge)
    participantList.appendChild(row)
  })

  participantListViewport.appendChild(participantList)
  return participantListViewport
}

function renderResults() {
  resultsDiv.innerHTML = ''
  resultsDiv.style.width = ''
  if (lastResults) {
    const participantColors = buildParticipantColorMap(lastResults)
    const roundIndex = Math.min(currentRoundIndex, lastResults.rounds.length - 1)
    const round = lastResults.rounds[roundIndex]
    const roundDiv = document.createElement('div')
    roundDiv.classList.add('round')
    roundDiv.appendChild(renderRoundHeader(roundIndex))
    roundDiv.appendChild(
      currentViewMode === 'participants'
        ? renderParticipantRound(round, participantColors)
        : renderTableRound(round, participantColors)
    )
    resultsDiv.appendChild(roundDiv)
    
    if (lastResults.done) {
      // Summary div - total time and CSV download
      const summaryDiv = document.createElement('div')
      summaryDiv.classList.add('resultsSummary');
      summaryDiv.style.borderTop = 'solid #aaaaaa thin'
      summaryDiv.style.padding = '7px 0'

      const csvButton = document.createElement('button')
      csvButton.type = 'button'
      csvButton.appendChild(document.createTextNode('Download CSV'))
      csvButton.onclick = downloadCsv

      const printButton = document.createElement('button')
      printButton.type = 'button'
      printButton.appendChild(document.createTextNode('Print Results'))
      printButton.onclick = () => window.print()
      
      const elapsedTime = document.createElement('span')
      elapsedTime.style.fontStyle = 'italic'
      elapsedTime.style.fontSize = 'smaller'
      if (lastComputationSeconds !== null) {
        elapsedTime.textContent = `Computed in ${lastComputationSeconds} seconds.`
      } else {
        elapsedTime.textContent = `Loaded from local storage.`
      }
      
      summaryDiv.appendChild(elapsedTime)
      summaryDiv.appendChild(csvButton)
      summaryDiv.appendChild(printButton)
      resultsDiv.appendChild(summaryDiv)
    } else {
      resultsDiv.appendChild(document.createTextNode('Thinking...'));
    }

    if (currentViewMode === 'tables') {
      syncTableLayout(round)
    } else {
      syncParticipantLayout(round)
    }
  }
}

function groupWidthForColumns(columnCount) {
  return (columnCount * GROUP_MEMBER_TILE_SIZE)
    + (Math.max(columnCount - 1, 0) * GROUP_MEMBER_GAP)
    + GROUP_CARD_PADDING
}

function applyTableColumns(groupsElement, columnCount) {
  const groupWidth = groupWidthForColumns(columnCount)
  groupsElement.style.setProperty('--group-member-columns', `${columnCount}`)
  groupsElement.style.setProperty('--group-width', `${groupWidth}px`)
  return groupWidth
}

function participantWidthForColumns(columnCount) {
  return (columnCount * PARTICIPANT_ASSIGNMENT_COLUMN_WIDTH)
    + (Math.max(columnCount - 1, 0) * PARTICIPANT_ASSIGNMENT_COLUMN_GAP)
}

function applyParticipantColumns(participantListElement, columnCount, assignmentCount) {
  const rowsPerColumn = Math.max(Math.ceil(assignmentCount / columnCount), 1)
  participantListElement.style.setProperty('--participant-assignment-columns', `${columnCount}`)
  participantListElement.style.setProperty('--participant-assignment-rows', `${rowsPerColumn}`)
  participantListElement.style.setProperty(
    '--participant-assignments-width',
    `${participantWidthForColumns(columnCount)}px`
  )
  return rowsPerColumn
}

function syncTableLayout(round) {
  const groupsElement = resultsDiv.querySelector('.groups')
  if (!groupsElement || !resultsShellDiv) return

  const maxTableSize = round.reduce((largest, group) => Math.max(largest, group.length), 1)
  const maxBottom = Math.min(window.innerHeight, resultsShellDiv.getBoundingClientRect().bottom)
  const startingColumnCount = maxTableSize > 1 ? 2 : 1

  for (let columnCount = startingColumnCount; columnCount <= maxTableSize; columnCount += 1) {
    applyTableColumns(groupsElement, columnCount)
    syncResultsWidth(round, columnCount)

    if (resultsDiv.getBoundingClientRect().bottom <= maxBottom || columnCount === maxTableSize) {
      return
    }
  }
}

function syncParticipantLayout(round) {
  const participantListElement = resultsDiv.querySelector('.participantAssignments')
  if (!participantListElement || !resultsShellDiv) return

  const assignmentCount = participantAssignmentsForRound(round).length
  const maxBottom = Math.min(window.innerHeight, resultsShellDiv.getBoundingClientRect().bottom)

  for (let columnCount = 1; columnCount <= assignmentCount; columnCount += 1) {
    applyParticipantColumns(participantListElement, columnCount, assignmentCount)
    syncResultsWidth(round, columnCount)

    if (resultsDiv.getBoundingClientRect().bottom <= maxBottom || columnCount === assignmentCount) {
      return
    }
  }
}

function syncResultsWidth(round, columnCount = null) {
  if (!resultsShellDiv) return

  const availableWidth = Math.max(resultsShellDiv.clientWidth, 0)
  if (availableWidth === 0) return

  if (currentViewMode === 'tables') {
    const tableCount = round.length
    const groupWidth = groupWidthForColumns(columnCount ?? 2)
    const desiredWidth = (tableCount * groupWidth)
      + (Math.max(tableCount - 1, 0) * GROUP_CARD_GAP)
      + RESULTS_PANEL_HORIZONTAL_PADDING
    const minimumWidth = Math.min(RESULTS_MIN_WIDTH, availableWidth)
    const finalWidth = Math.min(Math.max(desiredWidth, minimumWidth), availableWidth)
    resultsDiv.style.width = `${finalWidth}px`
    return
  }

  const desiredWidth = participantWidthForColumns(columnCount ?? 1) + RESULTS_PANEL_HORIZONTAL_PADDING
  const minimumWidth = Math.min(RESULTS_MIN_WIDTH, availableWidth)
  const finalWidth = Math.min(Math.max(desiredWidth, minimumWidth), availableWidth)
  resultsDiv.style.width = `${finalWidth}px`
}

document.addEventListener('DOMContentLoaded', init)
