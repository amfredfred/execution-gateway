import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';
import { DashboardAuthService } from './dashboard-auth.service';
import { DashboardConnectionRegistryService } from './dashboard-connection-registry.service';

interface DashboardAuthMessage {
  access_token?: string;
}

@WebSocketGateway({ path: '/dashboard' })
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);

  constructor(
    private readonly auth: DashboardAuthService,
    private readonly connections: DashboardConnectionRegistryService,
  ) {}

  handleConnection(socket: WebSocket) {
    this.connections.add(socket);
    this.logger.log(
      `Dashboard socket connected; total=${this.connections.count}`,
    );
  }

  handleDisconnect(socket: WebSocket) {
    this.connections.remove(socket);
    this.logger.log(
      `Dashboard socket disconnected; total=${this.connections.count}`,
    );
  }

  @SubscribeMessage('dashboard.authenticate')
  async authenticate(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: DashboardAuthMessage,
  ) {
    const user = await this.auth.verify(String(message?.access_token ?? ''));
    if (!user) {
      socket.close(1008, 'authentication_failed');
      return {
        event: 'dashboard.authentication_failed',
        data: { reason: 'invalid or expired access token' },
      };
    }

    this.connections.authenticate(socket, user.id, user.email ?? null);
    return {
      event: 'dashboard.authenticated',
      data: {
        user_id: user.id,
        email: user.email ?? null,
        authenticated_at: new Date().toISOString(),
      },
    };
  }

  @SubscribeMessage('dashboard.ping')
  ping(@ConnectedSocket() socket: WebSocket) {
    if (!this.connections.isAuthenticated(socket)) {
      return {
        event: 'dashboard.authentication_required',
        data: {},
      };
    }
    return {
      event: 'dashboard.pong',
      data: { observed_at: new Date().toISOString() },
    };
  }

  @SubscribeMessage('signal.metrics.subscribe')
  subscribeSignalMetrics(@ConnectedSocket() socket: WebSocket) {
    if (!this.connections.isAuthenticated(socket)) {
      return { event: 'dashboard.authentication_required', data: {} };
    }
    this.connections.subscribeSignalMetrics(socket);
    return {
      event: 'signal.metrics.subscribed',
      data: { subscribers: this.connections.signalMetricSubscriberCount },
    };
  }

  @SubscribeMessage('signal.metrics.unsubscribe')
  unsubscribeSignalMetrics(@ConnectedSocket() socket: WebSocket) {
    this.connections.unsubscribeSignalMetrics(socket);
    return {
      event: 'signal.metrics.unsubscribed',
      data: { subscribers: this.connections.signalMetricSubscriberCount },
    };
  }
}
