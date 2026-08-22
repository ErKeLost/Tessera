import {
  LibSqlConnector,
  type LibSqlConnectorOptions,
} from "@open-tessera/sqlite";

export type TursoConnectorOptions = Readonly<
  Omit<LibSqlConnectorOptions, "dialect">
>;

export function createTursoConnector(options: TursoConnectorOptions): TursoConnector {
  return new TursoConnector(options);
}

export class TursoConnector extends LibSqlConnector {
  constructor(options: TursoConnectorOptions) {
    super({ ...options, dialect: "turso" });
  }
}
