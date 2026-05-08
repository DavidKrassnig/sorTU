const GENERATIONS = 30
const RANDOM_MUTATIONS = 2
const MAX_DESCENDANTS_TO_EXPLORE = 100

/**
 * Attempt to quickly approach a solution for the social golfer problem in the given
 * configuration.
 * 
 * @param {number} groups how many groups per round
 * @param {number} totalPlayers how many players to distribute across groups
 * @param {number} forRounds how many rounds to compute
 * @param {boolean} withGroupLeaders gives the first <groups> players a special role.
 *        It will never match any pair of them, quickly assigning one to each group
 *        when generating permutations.
 * @param {number[][]} forbiddenPairs gives pairs of players that should never be grouped.
 *        These pairs are seeded with infinite weight.
 * @param {number[][]} discouragedGroups gives groups of players that should be discouraged,
 *        by default; each pairs is seeded with weight 1.
 * @param {function} onProgress is a callback for reporting partial or full results.
 */
function geneticSolver(
  groups, totalPlayers, forRounds, withGroupLeaders,
  forbiddenPairs=[], discouragedGroups=[], onProgress
  ) {
  const groupCapacities = evenlyDistributedGroupSizes(totalPlayers, groups)
  const leaderCount = withGroupLeaders ? Math.min(groups, totalPlayers) : 0

  // Weights represents the number of times a given pair has been grouped before,
  // or may sometimes have artificial constraints, like infinity weights for pairs
  // who should never be grouped.
  function score(round, weights) {
    const groupScores = round.map(group => {
      let groupCost = 0
      forEachPair(group, (a, b) => groupCost += Math.pow(weights[a][b], 2))
      return groupCost
    })
    return {
      groups: round,
      groupsScores: groupScores,
      total: groupScores.reduce((sum, next) => sum + next, 0),
    }
  }

  /**
   * Create a shuffled players-in-groups configuration, returned as nested arrays of integers.
   * For example, here are five groups of three:
   * 
   *     [
   *       [5, 3, 13],
   *       [11, 1, 6],
   *       [8, 14, 12],
   *       [9, 4, 0],
   *       [2, 10, 7],
   *     ]
   * 
   * When withGroupLeaders is set, the first <num_groups> players are deterministically
   * assigned to their groups while the rest are shuffled, producing something more like this:
   * 
   *     [
   *       [0, 9, 13],
   *       [1, 11, 6],
   *       [2, 14, 12],
   *       [3, 8, 5],
   *       [4, 10, 7],
   *     ]
   */
  function generatePermutation() {
    const shuffleStart = leaderCount;
    const shuffledPeople = _.shuffle(_.range(shuffleStart, totalPlayers));
    const remainingSeatsPerGroup = groupCapacities.map((capacity, groupIndex) =>
      capacity - (groupIndex < leaderCount ? 1 : 0)
    )
    let nextPlayerIndex = 0

    return _.range(groups).map(i => {
      const group = [];
      if (i < leaderCount) {
        group.push(i);
      }
      const seatsToFill = remainingSeatsPerGroup[i]
      group.push(...shuffledPeople.slice(nextPlayerIndex, nextPlayerIndex + seatsToFill));
      nextPlayerIndex += seatsToFill
      return group;
    });

  }

  function generateMutations(candidates, weights) {
    const mutations = []
    candidates.forEach(candidate => {
      const scoredGroups = candidate.groups.map((group, groupIndex) => ({
        group,
        groupIndex,
        score: candidate.groupsScores[groupIndex]
      }))
      const sortedScoredGroups = _.sortBy(scoredGroups, sg => sg.score).reverse()

      // Always push the original candidate back onto the list
      mutations.push(candidate)

      // Add every mutation that swaps somebody out of the most expensive group
      // (The first group is the most expensive now that we've sorted them)
      const mostExpensiveGroup = sortedScoredGroups[0]
      if (mostExpensiveGroup) {
        const sourcePositions = memberPositions(candidate.groups, mostExpensiveGroup.groupIndex)
          .filter(pos => !isLeaderPosition(pos))
        const targetPositions = candidate.groups.reduce((positions, _, groupIndex) => {
          if (groupIndex !== mostExpensiveGroup.groupIndex) {
            positions.push(...memberPositions(candidate.groups, groupIndex))
          }
          return positions
        }, []).filter(pos => !isLeaderPosition(pos))

        sourcePositions.forEach(sourcePos => {
          targetPositions.forEach(targetPos => {
            mutations.push(score(swap(candidate.groups, sourcePos, targetPos), weights))
          })
        })
      }

      // Add some random mutations to the search space to help break out of local peaks
      for (let i = 0; i < RANDOM_MUTATIONS; i++) {
        mutations.push(score(generatePermutation(), weights))
      }
    })
    return mutations;
  }

  function isLeaderPosition(position) {
    return withGroupLeaders
      && position.groupIndex < leaderCount
      && position.memberIndex === 0
  }

  function memberPositions(groups, groupIndex) {
    return groups[groupIndex].map((_, memberIndex) => ({groupIndex, memberIndex}))
  }

  function swap(groups, a, b) {
    const copy = groups.map(group => group.slice())
    const swappedOut = copy[a.groupIndex][a.memberIndex]
    copy[a.groupIndex][a.memberIndex] = copy[b.groupIndex][b.memberIndex]
    copy[b.groupIndex][b.memberIndex] = swappedOut
    return copy
  }

  function updateWeights(round, weights) {
    for (const group of round) {
      forEachPair(group, (a, b) => {
        weights[a][b] = weights[b][a] = (weights[a][b] + 1)
      })
    }
  }

  const weights = _.range(totalPlayers).map(() => _.range(totalPlayers).fill(0))

  // Fill some initial restrictions
  if (leaderCount > 0) {
    // Forbid every pairwise combination of group leaders
    for (let i = 0; i < leaderCount - 1; i++) {
      for (let j = i + 1; j < leaderCount; j++) {
        weights[i][j] = weights[j][i] = Infinity;
      }
    }
  }

  forbiddenPairs.forEach(group => {
    forEachPair(group, (a, b) => {
      if (a >= totalPlayers || b >= totalPlayers) return
      weights[a][b] = weights[b][a] = Infinity
    })
  })

  discouragedGroups.forEach(group => {
    forEachPair(group, (a, b) => {
      if (a >= totalPlayers || b >= totalPlayers) return
      weights[a][b] = weights[b][a] = (weights[a][b] + 1)
    })
  })

  const rounds = []
  const roundScores = []

  for (let round = 0; round < forRounds; round++) {
    let topOptions = _.range(5).map(() => score(generatePermutation(), weights))
    let generation = 0
    while (generation < GENERATIONS && topOptions[0].total > 0) {
      const candidates = generateMutations(topOptions, weights)
      let sorted = _.sortBy(candidates, c => c.total)
      const bestScore = sorted[0].total
      // Reduce to all the options that share the best score
      topOptions = sorted.slice(0, sorted.findIndex(opt => opt.total > bestScore))
      // Shuffle those options and only explore some maximum number of them
      topOptions = _.shuffle(topOptions).slice(0, MAX_DESCENDANTS_TO_EXPLORE)
      generation++;
    }
    const bestOption  = topOptions[0]
    rounds.push(bestOption.groups)
    roundScores.push(bestOption.total)
    updateWeights(bestOption.groups, weights)

    onProgress({
      rounds,
      roundScores,
      weights,
      done: (round+1) >= forRounds,
    })
  }
}

function evenlyDistributedGroupSizes(totalPlayers, groups) {
  const baseSize = Math.floor(totalPlayers / groups)
  const largerGroupCount = totalPlayers % groups
  return _.range(groups).map(groupIndex =>
    baseSize + (groupIndex < largerGroupCount ? 1 : 0)
  )
}

function forEachPair(array, callback) {
  for (let i = 0; i < array.length - 1; i++) {
    for (let j = i + 1; j < array.length; j++) {
      callback(array[i], array[j])
    }
  }
}
