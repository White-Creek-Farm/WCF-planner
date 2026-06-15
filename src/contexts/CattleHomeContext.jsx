// ============================================================================
// CattleHomeContext — Phase 2.0.6
// ============================================================================
// Thin Provider for the cattle summary state surfaced on the home dashboard.
//
//   cattleForHome      : lightweight directory for missed-report checks and Home animal snapshot
//   cattleOnFarmCount  : number — count of cattle currently on farm
// ============================================================================
import React, {createContext, useContext, useState} from 'react';

const CattleHomeContext = createContext(null);

export function CattleHomeProvider({children}) {
  const [cattleForHome, setCattleForHome] = useState([]);
  const [cattleOnFarmCount, setCattleOnFarmCount] = useState(0);

  const value = {
    cattleForHome,
    setCattleForHome,
    cattleOnFarmCount,
    setCattleOnFarmCount,
  };
  return <CattleHomeContext.Provider value={value}>{children}</CattleHomeContext.Provider>;
}

export function useCattleHome() {
  return useContext(CattleHomeContext);
}
