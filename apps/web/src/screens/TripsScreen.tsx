import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, Budget, Trip } from '../api';
import { colors, spacing, type } from '../theme';
import { Button, Card, clock, minutes } from '../components/ui';
import { TimeBar } from '../components/TimeBar';

type TripSummary = { id: string; title: string | null; origin: string; destination: string | null; departAt: string; returnAt: string; travelMode: string; intensity: string; stopCount: number };

export function TripsScreen() {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [open, setOpen] = useState<{ trip: Trip; stops: any[]; budget: Budget; attendees: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTrips((await api.trips()).trips); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (open) {
    const { trip, stops, budget } = open;
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Button label="← All trips" kind="ghost" onPress={() => setOpen(null)} style={{ alignSelf: 'flex-start' }} />
        <Text style={type.title}>{trip.title ?? trip.origin.label}</Text>
        <Text style={type.small}>{clock(trip.departAt)} – {clock(trip.returnAt)} · {trip.travelMode} · {trip.intensity}</Text>
        <Card>
          <TimeBar budget={budget} stops={stops.map((s) => ({ id: s.id, name: s.name, dwellMinutes: s.dwellMinutes }))} departAt={trip.departAt} returnAt={trip.returnAt} />
        </Card>
        {stops.length === 0 ? <Text style={type.small}>No stops yet — plan one from the first tab.</Text> : null}
        {stops.map((s, i) => (
          <Card key={s.id}>
            <Text style={type.h3}>{s.position}. {s.name}</Text>
            <Text style={type.small}>
              {budget.legs[i] ? `+${budget.legs[i].minutes} min from ${budget.legs[i].from}` : ''} · stay {minutes(s.dwellMinutes)}
            </Text>
          </Card>
        ))}
        {budget.legs.length > stops.length ? (
          <Text style={type.small}>Then {budget.legs[budget.legs.length - 1].minutes} min to {budget.legs[budget.legs.length - 1].to}.</Text>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={type.title}>Trips</Text>
      {error ? <Text style={[type.small, { color: colors.overrun }]}>{error}</Text> : null}
      {trips.map((t) => (
        <Pressable key={t.id} onPress={async () => setOpen(await api.trip(t.id))} accessibilityRole="button">
          <Card>
            <Text style={type.h3}>{t.title ?? t.origin}</Text>
            <Text style={type.small}>
              {new Date(t.departAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · {clock(t.departAt)}–{clock(t.returnAt)} · {t.stopCount} stop{t.stopCount === 1 ? '' : 's'}
            </Text>
          </Card>
        </Pressable>
      ))}
      {trips.length === 0 && !error ? <Text style={type.small}>No trips yet.</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 760, width: '100%', alignSelf: 'center' },
});
