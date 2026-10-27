// Tipos da resposta BRUTA da Open-Meteo Air Quality API. Usados somente dentro da integração.

export interface OpenMeteoCurrent {
  time: string; // ISO 8601 sem fuso, no fuso pedido na requisição (aqui sempre GMT)
  interval?: number;
  [variavel: string]: string | number | null | undefined;
}

export interface OpenMeteoAirQualityResponse {
  latitude: number; // centro da célula da grade do modelo, não a coordenada pedida
  longitude: number;
  utc_offset_seconds?: number;
  timezone?: string;
  current_units?: Record<string, string>;
  current: OpenMeteoCurrent;
}
