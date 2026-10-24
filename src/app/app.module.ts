import { Module, RouterModule } from '@preact-mvc/core';
import { AppShell } from './app.shell';
import { routes } from './app.routes';
import { APP_TITLE } from './core/tokens';

@Module({
  imports: [RouterModule.forRoot(routes)],
  providers: [{ provide: APP_TITLE, useValue: 'GearSwap UI' }],
  bootstrap: [AppShell],
})
export class AppModule {}
