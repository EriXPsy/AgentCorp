/**
 * Main Layout Component
 * TitleBar at top, then sidebar + content below.
 */
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { RightPanel } from './RightPanel';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { useTeamsStore } from '@/stores/teams';
import { useTeamGapMonitor } from '@/hooks/useTeamGapMonitor';

export function MainLayout() {
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  useEffect(() => {
    void fetchTeams().then(() => setTeamsLoaded(true));
  }, [fetchTeams]);

  // 团队缺口主动检测：有团队时启动轮询
  const teamIds = teamsLoaded ? teams.map((t) => t.id) : [];
  useTeamGapMonitor(teamIds);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Title bar: drag region on macOS, icon + controls on Windows */}
      <TitleBar />

      {/* Below the title bar: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-white dark:bg-background">
          <Outlet />
        </main>
        <RightPanel />
      </div>
    </div>
  );
}
