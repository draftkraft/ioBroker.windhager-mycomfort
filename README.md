# ioBroker.windhager-mycomfort

ioBroker adapter for Windhager myComfort cloud heating systems.

## Configuration

Configure the adapter instance in ioBroker Admin:

- myComfort email
- myComfort password
- system ID
- device identifier
- refresh interval in seconds
- read concurrency
- request timeout

The adapter marks `email` and `password` as `protectedNative`, and stores `password`
via `encryptedNative`.

## Object tree

The adapter creates states under its own namespace, for example:

```text
windhager-mycomfort.0
├── info
├── auth
├── settings
└── devices
     ├── biowin_ii
     │   ├── boiler_temp_current_value          r
     │   ├── boiler_output                      r
     │   ├── boiler_temp_setpoint               r
     │   └── ...
     │
     ├── haus_radiator
         ├── room_temperature_current_value     r
         ├── flow_temperature_current_value     r
         ├── room_temperature_setpoint_heating  r/w
         ├── heating_mode_temperature           r/w
         ├── setback_mode_temperature           r/w
         ├── flow_temperature_setpoint          r
         ├── programs
         │   ├── program_1
         │   │   ├── heating_start_time         r/w
         │   │   ├── heating_target_temperature r/w
         │   │   ├── setback_start_time         r/w
         │   │   └── setback_target_temperature r/w
         │   ├── program_2
         │   └── program_3
         └── operating_mode                     r

```

Device states are created dynamically from the Windhager datapoints returned by
the cloud API. Technical IDs such as `nodeId`, `functionId`, and `oid` are stored
in each state's `native` object.

Heating circuits also expose editable Program 1-3 schedules. Each program is
represented as two all-week switch points: heating and setback. Writing any of
the four program states writes the complete normalized program schedule back to
Windhager.

Program schedules are refreshed on adapter startup and after program writes.
Normal periodic refreshes only read live datapoints, so slow Windhager program
reads do not clear existing program states. Windhager writes are serialized,
retried for transient timeout/server-busy errors, and exposed through
`info.writeQueueLength` and `info.lastWriteError`.

Every datapoint write is read back from Windhager and is only acknowledged in
ioBroker after the requested value is confirmed. Before retrying a failed PUT,
the adapter reads the value first so a command whose response was lost is not
needlessly repeated. Transient network and HTTP failures are retried after 5,
15, and 45 seconds.

If all attempts fail, `info.writeAlert` changes to `true`,
`info.lastWriteError` contains the reason, and `info.lastFailedWriteAt` records
the failure time. Use the rising edge of `info.writeAlert` as the trigger for an
ioBroker notification, email, or messaging automation. A later confirmed write
clears the alert.
