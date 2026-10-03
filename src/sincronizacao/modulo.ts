import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { Fila, Parceira, Repositorio, Telemetria } from './contratos.js';
import { ConsumidorSincronizacao } from './consumidor.js';

@Module({})
export class SincronizacaoModule {
  static registrar(dependencias: {
    parceira: Parceira; repositorio: Repositorio; fila: Fila; telemetria: Telemetria;
  }): DynamicModule {
    return {
      module: SincronizacaoModule,
      providers: [
        { provide: Parceira, useValue: dependencias.parceira },
        { provide: Repositorio, useValue: dependencias.repositorio },
        { provide: Fila, useValue: dependencias.fila },
        { provide: Telemetria, useValue: dependencias.telemetria },
        ConsumidorSincronizacao,
      ],
      exports: [ConsumidorSincronizacao],
    };
  }
}
