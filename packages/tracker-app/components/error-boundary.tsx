import React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors below it and offers a retry instead of a white screen.
 *
 * Deliberately styled with plain `style` props rather than NativeWind classes:
 * this is what renders when something has already gone wrong, so it must not
 * depend on the styling pipeline, the theme provider or any context that may
 * itself be the thing that failed.
 */
export class AppErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  resetError = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#040711',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
        }}
      >
        <View style={{ maxWidth: 400, width: '100%', alignItems: 'center' }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <Text style={{ fontSize: 24, color: '#ef4444', fontWeight: '600' }}>!</Text>
          </View>

          <Text
            style={{
              fontSize: 20,
              fontWeight: '700',
              color: '#f1f5f9',
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            Algo ha fallado
          </Text>

          <Text
            style={{
              fontSize: 15,
              color: '#94a3b8',
              textAlign: 'center',
              lineHeight: 22,
              marginBottom: 24,
            }}
          >
            Ha ocurrido un error inesperado. Puedes volver a intentarlo; tu número de
            seguimiento no se ha perdido.
          </Text>

          {__DEV__ && (
            <ScrollView
              style={{
                maxHeight: 120,
                width: '100%',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                borderRadius: 8,
                padding: 12,
                marginBottom: 24,
              }}
            >
              <Text
                selectable
                style={{
                  fontSize: 12,
                  color: '#64748b',
                  fontFamily: Platform.OS === 'web' ? 'monospace' : 'SpaceMono',
                }}
              >
                {error.message}
              </Text>
            </ScrollView>
          )}

          <Pressable
            onPress={this.resetError}
            accessibilityRole="button"
            accessibilityLabel="Volver a intentarlo"
            style={({ pressed }) => ({
              backgroundColor: pressed ? '#7c3aed' : '#8b5cf6',
              paddingHorizontal: 28,
              paddingVertical: 12,
              borderRadius: 12,
              width: '100%',
              alignItems: 'center',
            })}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: '#ffffff' }}>
              Reintentar
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }
}
