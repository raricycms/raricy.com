import { launchRealtimeGame } from '../../realtime-launch';

export async function POST(request: Request) {
  return launchRealtimeGame(request, 'public-space');
}
